#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
ISSUE_NUMBER="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Immutable worker code (libs, prompts, sibling scripts) lives next to this script.
WORKER_CODE_DIR="$SCRIPT_DIR"
# Runtime data (conf, logs, state, .env). Override with AI_WORKER_BASE_DIR when needed.
BASE_DIR="${AI_WORKER_BASE_DIR:-$SCRIPT_DIR}"
export WORKER_CODE_DIR BASE_DIR

PROJECTS_FILE="$BASE_DIR/gitlab-projects.conf"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/logs"

# shellcheck source=lib/common.sh
source "$WORKER_CODE_DIR/lib/common.sh"
# shellcheck source=lib/prompts.sh
source "$WORKER_CODE_DIR/lib/prompts.sh"
# shellcheck source=lib/related-tasks.sh
source "$WORKER_CODE_DIR/lib/related-tasks.sh"
# shellcheck source=lib/ai.sh
source "$WORKER_CODE_DIR/lib/ai.sh"
# shellcheck source=lib/gitlab.sh
source "$WORKER_CODE_DIR/lib/gitlab.sh"
# shellcheck source=lib/labels.sh
source "$WORKER_CODE_DIR/lib/labels.sh"

mkdir -p "$STATE_DIR" "$LOG_DIR"
ai_load_env "$BASE_DIR/.env"

# ============================================================
# Validate input
# ============================================================

if [[ -z "$PROJECT" || -z "$ISSUE_NUMBER" ]]; then
    echo "Usage: $0 <project> <issue-iid>"
    exit 1
fi

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: issue number must be numeric."
    exit 1
fi

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: GitLab projects file not found: $PROJECTS_FILE"
    exit 1
fi

if ! gitlab_configured; then
    echo "ERROR: GITLAB_TOKEN is not set."
    echo "Create $BASE_DIR/.env from .env.example"
    exit 1
fi

ai_require_cmds git curl jq tee || exit 1

# AI provider is initialized later — skipped for title "new release" / "new tag".

# ============================================================
# Resolve project
# ============================================================

PROJECT_ENTRY="$(ai_resolve_project_entry "$PROJECTS_FILE" "$PROJECT")" || true
PROJECT_DIR="$(jq -r '.path // empty' <<<"${PROJECT_ENTRY:-}")"
DEFAULT_BRANCH="$(ai_project_default_branch "${PROJECT_ENTRY:-}")"
FORCE_PUSH_TO_DEFAULT="$(ai_project_entry_bool "${PROJECT_ENTRY:-}" "force_push_to_default" 0)"

if [[ -z "$PROJECT_DIR" ]]; then
    echo "ERROR: Project is not registered: $PROJECT"
    exit 1
fi

if ! ai_validate_project_dir "$PROJECT" "$PROJECT_DIR"; then
    echo "ERROR: Invalid project directory for: $PROJECT"
    exit 1
fi

# ============================================================
# Log files
# ============================================================

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

LOG_FILE="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.log"
AGENT_LOG="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.agent.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.result.txt"
NOTES_SAVED="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}-notes.md"
RELATED_TASKS_SAVED="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}-related-tasks.json"
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

BRANCH=""
REPO_PATH=""
ISSUE_TITLE=""
ISSUE_URL=""
MR_URL=""
MR_IID=""
NOTES_FILE=""
RELATED_TASKS_FILE=""
NOTES_COMMENT_URL=""

# ============================================================
# Cleanup
# ============================================================

cleanup() {
    rc=$?

    trap - EXIT INT TERM
    set +e

    ai_log_banner "CLEANUP"
    echo "Exit code: $rc"

    if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then

        current_branch="$(
            git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
        )"

        if [[ "$current_branch" != "$DEFAULT_BRANCH" ]]; then

            if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then

                echo "Discarding remaining task changes before returning to $DEFAULT_BRANCH..."
                echo
                echo "Changed files before cleanup:"
                git -C "$PROJECT_DIR" status --short || true

                git -C "$PROJECT_DIR" reset --hard HEAD || true
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo
            echo "Checking out $DEFAULT_BRANCH..."
            git -C "$PROJECT_DIR" checkout "$DEFAULT_BRANCH" || true
        fi

        if [[ -n "$BRANCH" ]] &&
           git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then

            if [[ "$(
                git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
            )" != "$BRANCH" ]]; then

                echo "Deleting local task branch:"
                echo "$BRANCH"
                git -C "$PROJECT_DIR" branch -D "$BRANCH" || true
            fi
        fi
    fi

    if [[ -n "${NOTES_FILE:-}" ]]; then
        rm -f "$NOTES_FILE"
    fi
    ai_remove_ai_artifact_files "$PROJECT_DIR" 2>/dev/null || true

    rm -f "$STATE_FILE"

    echo
    echo "Current branch: $(
        git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo unknown
    )"
    echo "Finished: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    exit "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ============================================================
# State file
# ============================================================

cat > "$STATE_FILE" <<EOF
forge=gitlab
project=$PROJECT
issue=$ISSUE_NUMBER
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "AI GITLAB ISSUE WORKER"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Forge:         gitlab"
echo "Host:          $GITLAB_HOST"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Default branch: $DEFAULT_BRANCH"
echo "Force-push:    $([[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]] && echo enabled || echo disabled)"
echo "Project dir:   $PROJECT_DIR"
echo "Main log:      $LOG_FILE"
echo "============================================================"

# ============================================================
# Determine GitLab project path
# ============================================================

REPO_PATH="$(gitlab_resolve_project_path "$PROJECT_DIR")" || true

if [[ -z "$REPO_PATH" ]]; then
    echo "ERROR: Could not determine GitLab project path from origin."
    exit 11
fi

echo
echo "GitLab project: $REPO_PATH"
ai_ensure_project_labels gitlab "$REPO_PATH" "$PROJECT"
ai_configure_ssh_git_remote "$PROJECT_DIR"
echo "Origin: $(git -C "$PROJECT_DIR" remote get-url origin)"

# ============================================================
# Fresh environment: clean checkout of up-to-date default branch
# ============================================================

# Drop leftover task branches / dirty state from prior runs so every issue
# starts from a clean, current default branch (explicit fetch + hard reset).
ai_prepare_fresh_branch "$PROJECT_DIR" "$DEFAULT_BRANCH" || exit $?

# ============================================================
# Read GitLab issue
# ============================================================

echo
echo "Reading GitLab issue #$ISSUE_NUMBER..."

ISSUE_JSON="$(gitlab_get_issue "$REPO_PATH" "$ISSUE_NUMBER")"

ISSUE_TITLE="$(jq -r '.title' <<<"$ISSUE_JSON")"
ISSUE_BODY="$(jq -r '.description // ""' <<<"$ISSUE_JSON")"
ISSUE_URL="$(jq -r '.web_url' <<<"$ISSUE_JSON")"
ISSUE_STATE="$(jq -r '.state' <<<"$ISSUE_JSON")"

echo
echo "Title: $ISSUE_TITLE"
echo "State: $ISSUE_STATE"
echo "URL:   $ISSUE_URL"

if [[ "$ISSUE_STATE" != "opened" ]]; then
    echo
    echo "Issue is not open."
    echo "Nothing to do."
    exit 0
fi

# ============================================================
# Special case: title "new release" or "new tag"
#
# Skip the AI agent. Sync tags, bump past the highest
# vMAJOR.MINOR.PATCH from git tags or GitLab releases
# (including upcoming), and create an upcoming GitLab release
# (draft-like; does not publish as current until released_at).
# ============================================================

ISSUE_TITLE_NORM="$(ai_normalize_issue_title "$ISSUE_TITLE")"

if ai_is_new_release_title "$ISSUE_TITLE"; then

    ai_log_banner "NEW RELEASE / NEW TAG (NO AI)"
    echo "Issue title matches '$ISSUE_TITLE_NORM'."
    echo "Skipping AI agent; creating the next upcoming GitLab release."
    echo "============================================================"

    echo
    echo "Fetching all tags from origin..."

    git -C "$PROJECT_DIR" fetch --tags --prune origin

    LATEST_GIT_TAG="$(ai_latest_git_semver_tag "$PROJECT_DIR")"
    echo "Latest git tag:     ${LATEST_GIT_TAG:-<none>}"

    echo
    echo "Checking GitLab releases (including upcoming)..."

    LATEST_RELEASE_TAG="$(
        gitlab_list_release_tags "$REPO_PATH" |
            ai_max_semver_tag_from_lines
    )"

    echo "Latest release tag: ${LATEST_RELEASE_TAG:-<none>}"

    LATEST_TAG="$(
        printf '%s\n%s\n' "$LATEST_GIT_TAG" "$LATEST_RELEASE_TAG" |
            ai_max_semver_tag_from_lines
    )"

    if [[ -z "$LATEST_TAG" ]]; then
        echo
        echo "ERROR: No tags matching vMAJOR.MINOR.PATCH were found."
        echo "Create an initial tag (for example v0.0.1) before using 'new release'."
        exit 50
    fi

    if ! NEW_TAG="$(ai_bump_semver_patch "$LATEST_TAG")"; then
        echo
        echo "ERROR: Latest tag is not in vMAJOR.MINOR.PATCH format: $LATEST_TAG"
        exit 51
    fi

    while ai_git_tag_exists "$PROJECT_DIR" "$NEW_TAG" ||
          gitlab_release_exists "$REPO_PATH" "$NEW_TAG"; do
        echo "Candidate $NEW_TAG already exists; bumping patch again..."
        NEW_TAG="$(ai_bump_semver_patch "$NEW_TAG")"
    done

    echo
    echo "Latest used: $LATEST_TAG"
    echo "New tag:     $NEW_TAG"

    RELEASE_DESCRIPTION="$(cat <<EOF
## Automated upcoming release

Created by the AI worker because issue title is \`${ISSUE_TITLE_NORM}\`.

- Previous tag: \`${LATEST_TAG}\`
- New tag: \`${NEW_TAG}\`
- Source ref: \`${DEFAULT_BRANCH}\`

This is an **upcoming** release (not the current published release). Update \`released_at\` or edit the release on GitLab when you are ready. The automation never marks releases as current automatically.
EOF
)"

    echo
    echo "Creating upcoming GitLab release: $NEW_TAG (from $DEFAULT_BRANCH)"

    RELEASE_URL="$(
        gitlab_create_upcoming_release \
            "$REPO_PATH" \
            "$NEW_TAG" \
            "$DEFAULT_BRANCH" \
            "$RELEASE_DESCRIPTION"
    )"

    if [[ -z "$RELEASE_URL" ]]; then
        echo
        echo "ERROR: GitLab release create did not return a release URL."
        exit 54
    fi

    echo
    echo "Upcoming release created:"
    echo "$RELEASE_URL"

    COMMENT_BODY="$(cat <<EOF
## Automated upcoming release

Skipped the AI agent because this issue title is \`$ISSUE_TITLE_NORM\`.

- Previous tag: \`$LATEST_TAG\`
- New upcoming release: \`$NEW_TAG\`
- URL: $RELEASE_URL

GitLab has no draft releases; this was created as an **upcoming** release. Edit or set \`released_at\` when you are ready. This automation never publishes releases as current automatically.
EOF
)"

    echo
    echo "Commenting on issue #$ISSUE_NUMBER..."
    gitlab_create_issue_note "$REPO_PATH" "$ISSUE_NUMBER" "$COMMENT_BODY" >/dev/null

    echo
    echo "Closing issue #$ISSUE_NUMBER..."
    gitlab_close_issue "$REPO_PATH" "$ISSUE_NUMBER"

    cat > "$RESULT_FILE" <<EOF
forge=gitlab
project=$PROJECT
repository=$REPO_PATH
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
mode=new-release
previous_tag=$LATEST_TAG
new_tag=$NEW_TAG
release_url=$RELEASE_URL
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
EOF

    ai_log_banner "RELEASE COMPLETE"
    echo "Forge:        gitlab"
    echo "Project:      $PROJECT"
    echo "Issue:        #$ISSUE_NUMBER"
    echo "Previous tag: $LATEST_TAG"
    echo "New tag:      $NEW_TAG"
    echo "Release:      $RELEASE_URL"
    echo "Main log:     $LOG_FILE"
    echo "Result file:  $RESULT_FILE"
    echo "============================================================"

    exit 0
fi

# ============================================================
# Initialize AI provider (normal issue path)
# ============================================================

ai_init || exit 1

cat >> "$STATE_FILE" <<EOF
ai_provider=$AI_PROVIDER
EOF

echo
echo "AI provider:   $AI_PROVIDER_NAME ($AI_PROVIDER)"
echo "AI binary:     $AI_PROVIDER_BIN"
echo "Agent log:     $AGENT_LOG"
echo "Agent stderr:  $AGENT_ERR_LOG"

# ============================================================
# Read issue comments
# ============================================================

echo
echo "Fetching issue comments..."

ISSUE_NOTES_JSON="$(gitlab_list_issue_notes "$REPO_PATH" "$ISSUE_NUMBER")"
ISSUE_COMMENTS_COUNT="$(jq 'length' <<<"$ISSUE_NOTES_JSON")"
ISSUE_COMMENTS_TEXT="$(gitlab_format_notes "$ISSUE_NOTES_JSON")"

echo "Comments: $ISSUE_COMMENTS_COUNT"

# ============================================================
# Create branch
# ============================================================

BASE_BRANCH="ai/issue-${ISSUE_NUMBER}"
BRANCH="$BASE_BRANCH"

if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH" ||
   git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    BRANCH="${BASE_BRANCH}-${TIMESTAMP}"
fi

echo
echo "Creating task branch:"
echo "$BRANCH"

git -C "$PROJECT_DIR" checkout -b "$BRANCH" "$DEFAULT_BRANCH"

# Expose branch to platform heartbeat / Tasks UI while this run is active.
printf 'branch=%s\n' "$BRANCH" >> "$STATE_FILE"

# ============================================================
# Build AI prompt
# ============================================================

NOTES_FILE="$PROJECT_DIR/.ai-mr-notes.md"
rm -f "$NOTES_FILE"
RELATED_TASKS_FILE="$PROJECT_DIR/.ai-related-tasks.json"
rm -f "$RELATED_TASKS_FILE"

ai_prompt_clear
ai_prompt_load_repo_custom "$PROJECTS_FILE" "$PROJECT"
ai_prompt_set REPO_PATH "$REPO_PATH"
ai_prompt_set GITLAB_HOST "$GITLAB_HOST"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set ISSUE_NUMBER "$ISSUE_NUMBER"
ai_prompt_set ISSUE_URL "$ISSUE_URL"
ai_prompt_set ISSUE_TITLE "$ISSUE_TITLE"
ai_prompt_set ISSUE_BODY "$ISSUE_BODY"
ai_prompt_set ISSUE_COMMENTS_TEXT "$ISSUE_COMMENTS_TEXT"
ai_prompt_set NOTES_FILE "$NOTES_FILE"
ai_prompt_set RELATED_TASKS_FILE "$RELATED_TASKS_FILE"
ai_prompt_set SOURCE_PROJECT "$PROJECT"
ai_prompt_set REGISTERED_PROJECTS "$(ai_registered_projects_text)"

ai_prompt_render "gitlab-issue-implement.txt" "$PROMPT_FILE"

# ============================================================
# Run Cursor
# ============================================================

ai_log_agent_start "STARTING AI AGENT"
echo "Branch:        $BRANCH"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Agent stderr:  $AGENT_ERR_LOG"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"

ai_run_agent "$PROJECT_DIR" "$PROMPT_FILE" "$AGENT_LOG" "$AGENT_ERR_LOG" implement

ai_log_agent_finish

if [[ "$AGENT_EXIT_CODE" -ne 0 ]]; then
    echo
    echo "ERROR: AI agent failed."
    exit "$AGENT_EXIT_CODE"
fi

# ============================================================
# Verify Cursor changed something
# ============================================================

echo
echo "Git status after Cursor:"
git -C "$PROJECT_DIR" status --short

# Capture merge notes before staging so they are never committed.
ai_capture_implement_notes "$NOTES_FILE" "$NOTES_SAVED" || true
ai_capture_related_tasks_file "$RELATED_TASKS_FILE" "$RELATED_TASKS_SAVED" || true

DECLINED_NO_CHANGES=0
if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    if ai_notes_explain_no_implementation "$NOTES_SAVED"; then
        DECLINED_NO_CHANGES=1
        echo
        echo "Agent declined the issue (no product-file changes)."
        if [[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]]; then
            echo "Force-push mode: skipping empty commit; posting explanation on the issue."
        else
            echo "Opening an empty-commit merge request with the explanation."
        fi
    else
        echo
        echo "ERROR: Cursor completed but made no changes."
        exit 20
    fi
fi

if [[ "$DECLINED_NO_CHANGES" -eq 0 ]]; then
    ai_apply_related_tasks \
        "$RELATED_TASKS_SAVED" \
        "$PROJECT" \
        "GitLab issue #${ISSUE_NUMBER} (${ISSUE_URL})" \
        "$ISSUE_BODY" || true
fi

# ============================================================
# Stage changes
# ============================================================

if [[ "$DECLINED_NO_CHANGES" -eq 0 ]]; then
    echo
    echo "Staging changes..."
    git -C "$PROJECT_DIR" add -A
    ai_unstage_ai_artifact_files "$PROJECT_DIR"

    CHANGED_FILES="$(
        git -C "$PROJECT_DIR" diff --cached --name-only
    )"

    echo
    echo "Files to commit:"
    printf '%s\n' "$CHANGED_FILES"

    if ai_has_secret_files "$CHANGED_FILES"; then
        echo
        echo "ERROR: A potential secret/private-key file is staged."
        echo "Refusing to continue."
        exit 30
    fi

    if git -C "$PROJECT_DIR" diff --cached --quiet; then
        echo
        echo "ERROR: Nothing staged after Cursor changes."
        exit 21
    fi
fi

# ============================================================
# Commit / publish (MR or force-push to default branch)
# ============================================================

MR_URL=""
MR_IID=""
NOTES_COMMENT_URL=""
COMMIT_SHA=""

if [[ "$FORCE_PUSH_TO_DEFAULT" == "1" && "$DECLINED_NO_CHANGES" -eq 1 ]]; then
    echo
    echo "Force-push mode: no product changes; not updating origin/$DEFAULT_BRANCH."
    COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
else
    echo
    echo "Creating commit..."
    if [[ "$DECLINED_NO_CHANGES" -eq 1 ]]; then
        git -C "$PROJECT_DIR" commit \
            --allow-empty \
            -m "chore: no code changes for issue #${ISSUE_NUMBER}"
    else
        git -C "$PROJECT_DIR" commit \
            -m "fix: resolve issue #${ISSUE_NUMBER}"
    fi

    COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

    echo
    echo "Commit:"
    echo "$COMMIT_SHA"
fi

if [[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]]; then
    if [[ "$DECLINED_NO_CHANGES" -eq 0 ]]; then
        echo
        echo "Force-pushing commit to origin/$DEFAULT_BRANCH (skipping merge request)..."
        git -C "$PROJECT_DIR" push --force origin "HEAD:refs/heads/${DEFAULT_BRANCH}"

        git -C "$PROJECT_DIR" fetch origin "$DEFAULT_BRANCH" || true
        git -C "$PROJECT_DIR" checkout -B "$DEFAULT_BRANCH" "origin/$DEFAULT_BRANCH"
        git -C "$PROJECT_DIR" reset --hard "origin/$DEFAULT_BRANCH"
        BRANCH="$DEFAULT_BRANCH"
        printf 'branch=%s\n' "$BRANCH" >> "$STATE_FILE"
    fi

    ISSUE_COMMENT_FILE="$STATE_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}-force-push-comment.md"
    if [[ "$DECLINED_NO_CHANGES" -eq 1 ]]; then
        cat > "$ISSUE_COMMENT_FILE" <<EOF
## Not implemented (force-push mode)

No product-file changes were made, and \`origin/${DEFAULT_BRANCH}\` was **not** updated.

**Commit (local):** \`$COMMIT_SHA\`

### Why this was not implemented

$(cat "$NOTES_SAVED" 2>/dev/null || echo "_No notes file._")
EOF
    else
        cat > "$ISSUE_COMMENT_FILE" <<EOF
## Automated implementation (force-push)

Changes were force-pushed directly to \`${DEFAULT_BRANCH}\` (merge request skipped for this repository).

**Branch:** \`${DEFAULT_BRANCH}\`

**Commit:** \`$COMMIT_SHA\`

Closes #${ISSUE_NUMBER}
EOF
        if [[ -f "$NOTES_SAVED" ]]; then
            {
                echo
                echo "### Implement notes"
                echo
                cat "$NOTES_SAVED"
            } >> "$ISSUE_COMMENT_FILE"
        fi
    fi

    echo
    echo "Posting result comment on issue #$ISSUE_NUMBER..."
    NOTE_JSON="$(gitlab_create_issue_note "$REPO_PATH" "$ISSUE_NUMBER" "$(cat "$ISSUE_COMMENT_FILE")" || true)"
    NOTES_COMMENT_URL="$(jq -r '.web_url // empty' <<<"${NOTE_JSON:-}" 2>/dev/null || true)"
    if [[ -z "$NOTES_COMMENT_URL" ]]; then
        echo "WARNING: Issue comment was not posted."
    fi
else
    echo
    echo "Pushing branch..."
    git -C "$PROJECT_DIR" push -u origin "$BRANCH"

    MR_BODY_FILE="$STATE_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}-mr.md"

    if [[ "$DECLINED_NO_CHANGES" -eq 1 ]]; then
        cat > "$MR_BODY_FILE" <<EOF
## Not implemented

This merge request contains **no product-file changes**. The agent judged the issue unrelated to this repository, not acceptable, or not useful to implement.

**Issue:** $ISSUE_URL

**Branch:** \`$BRANCH\`

**Commit:** \`$COMMIT_SHA\`

Related to #${ISSUE_NUMBER}

### Why this was not implemented

$(cat "$NOTES_SAVED")

The automation never merges merge requests automatically.
EOF
        MR_TITLE="No changes for #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
    else
        cat > "$MR_BODY_FILE" <<EOF
## Automated implementation

This merge request was created automatically by the server-side Cursor issue worker.

**Issue:** $ISSUE_URL

**Branch:** \`$BRANCH\`

**Commit:** \`$COMMIT_SHA\`

Closes #${ISSUE_NUMBER}

### Review note

Please review the implementation and CI results before merging.

The automation never merges merge requests automatically.
EOF
        MR_TITLE="Fix #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
    fi

    echo
    echo "Creating merge request..."

    MR_JSON="$(
        gitlab_create_mr \
            "$REPO_PATH" \
            "$BRANCH" \
            "$DEFAULT_BRANCH" \
            "$MR_TITLE" \
            "$(cat "$MR_BODY_FILE")" \
            "ai-pr"
    )"

    MR_URL="$(jq -r '.web_url // empty' <<<"$MR_JSON")"
    MR_IID="$(jq -r '.iid // empty' <<<"$MR_JSON")"

    if [[ -z "$MR_URL" || -z "$MR_IID" ]]; then
        echo
        echo "ERROR: Merge request creation could not be verified."
        echo "$MR_JSON"
        exit 40
    fi

    echo
    echo "Ensuring merge request has label ai-pr..."
    if ! gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" --add "ai-pr"; then
        echo "WARNING: Could not add ai-pr label to merge request !$MR_IID."
    fi

    if [[ -f "$NOTES_SAVED" ]]; then
        if NOTES_COMMENT_URL="$(ai_post_gitlab_mr_notes "$REPO_PATH" "$MR_IID" "$NOTES_SAVED")"; then
            :
        else
            NOTES_COMMENT_URL=""
            echo "WARNING: Implement notes comment was not posted."
        fi
    else
        echo "WARNING: No implement notes file to post as an MR comment."
    fi
fi

# ============================================================
# Save result
# ============================================================

cat > "$RESULT_FILE" <<EOF
forge=gitlab
project=$PROJECT
repository=$REPO_PATH
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
branch=$BRANCH
commit=$COMMIT_SHA
force_push_to_default=$FORCE_PUSH_TO_DEFAULT
merge_request=$MR_URL
merge_request_iid=$MR_IID
notes_file=$NOTES_SAVED
notes_comment=$NOTES_COMMENT_URL
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "ISSUE COMPLETE"
echo "Forge:         gitlab"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Branch:        $BRANCH"
echo "Commit:        $COMMIT_SHA"
if [[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]]; then
    echo "Published:     force-push to origin/$DEFAULT_BRANCH"
else
    echo "Merge request: $MR_URL"
fi
if [[ -n "$NOTES_COMMENT_URL" ]]; then
    echo "Notes comment: $NOTES_COMMENT_URL"
fi
echo "Main log:      $LOG_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
