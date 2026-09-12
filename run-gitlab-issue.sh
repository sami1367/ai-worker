#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
ISSUE_NUMBER="${2:-}"

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/gitlab-projects.conf"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/logs"

# shellcheck source=lib/common.sh
source "$BASE_DIR/lib/common.sh"
# shellcheck source=lib/prompts.sh
source "$BASE_DIR/lib/prompts.sh"
# shellcheck source=lib/ai.sh
source "$BASE_DIR/lib/ai.sh"
# shellcheck source=lib/gitlab.sh
source "$BASE_DIR/lib/gitlab.sh"

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

PROJECT_DIR="$(ai_resolve_project_dir "$PROJECTS_FILE" "$PROJECT")"

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
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

BRANCH=""
REPO_PATH=""
ISSUE_TITLE=""
ISSUE_URL=""
MR_URL=""
MR_IID=""
NOTES_FILE=""
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

        if [[ "$current_branch" != "main" ]]; then

            if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then

                echo "Discarding remaining task changes before returning to main..."
                echo
                echo "Changed files before cleanup:"
                git -C "$PROJECT_DIR" status --short || true

                git -C "$PROJECT_DIR" reset --hard HEAD || true
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo
            echo "Checking out main..."
            git -C "$PROJECT_DIR" checkout main || true
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
echo "Project dir:   $PROJECT_DIR"
echo "Main log:      $LOG_FILE"
echo "============================================================"

# ============================================================
# Repository must start clean
# ============================================================

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo
    echo "ERROR: Repository has uncommitted/untracked changes before starting."
    git -C "$PROJECT_DIR" status --short
    exit 10
fi

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
echo "Origin: $(git -C "$PROJECT_DIR" remote get-url origin)"

# ============================================================
# Update main
# ============================================================

echo
echo "Fetching origin..."
git -C "$PROJECT_DIR" fetch --prune origin

echo
echo "Checking out main..."
git -C "$PROJECT_DIR" checkout main

echo
echo "Updating main with fast-forward only..."
git -C "$PROJECT_DIR" pull --ff-only origin main

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo
    echo "ERROR: main is not clean after update."
    git -C "$PROJECT_DIR" status --short
    exit 12
fi

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
- Source ref: \`main\`

This is an **upcoming** release (not the current published release). Update \`released_at\` or edit the release on GitLab when you are ready. The automation never marks releases as current automatically.
EOF
)"

    echo
    echo "Creating upcoming GitLab release: $NEW_TAG (from main)"

    RELEASE_URL="$(
        gitlab_create_upcoming_release \
            "$REPO_PATH" \
            "$NEW_TAG" \
            "main" \
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

git -C "$PROJECT_DIR" checkout -b "$BRANCH" main

# ============================================================
# Build AI prompt
# ============================================================

NOTES_FILE="$PROJECT_DIR/.ai-mr-notes.md"
rm -f "$NOTES_FILE"

ai_prompt_clear
ai_prompt_set REPO_PATH "$REPO_PATH"
ai_prompt_set GITLAB_HOST "$GITLAB_HOST"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set ISSUE_NUMBER "$ISSUE_NUMBER"
ai_prompt_set ISSUE_URL "$ISSUE_URL"
ai_prompt_set ISSUE_TITLE "$ISSUE_TITLE"
ai_prompt_set ISSUE_BODY "$ISSUE_BODY"
ai_prompt_set ISSUE_COMMENTS_TEXT "$ISSUE_COMMENTS_TEXT"
ai_prompt_set NOTES_FILE "$NOTES_FILE"

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

if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo
    echo "ERROR: Cursor completed but made no changes."
    exit 20
fi

# ============================================================
# Stage changes
# ============================================================

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

# ============================================================
# Commit
# ============================================================

echo
echo "Creating commit..."
git -C "$PROJECT_DIR" commit \
    -m "fix: resolve issue #${ISSUE_NUMBER}"

COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

echo
echo "Commit:"
echo "$COMMIT_SHA"

# ============================================================
# Push
# ============================================================

echo
echo "Pushing branch..."
git -C "$PROJECT_DIR" push -u origin "$BRANCH"

# ============================================================
# Create MR body
# ============================================================

MR_BODY_FILE="$STATE_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}-mr.md"

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

# ============================================================
# Create Merge Request
# ============================================================

echo
echo "Creating merge request..."

MR_JSON="$(
    gitlab_create_mr \
        "$REPO_PATH" \
        "$BRANCH" \
        "main" \
        "Fix #${ISSUE_NUMBER}: ${ISSUE_TITLE}" \
        "$(cat "$MR_BODY_FILE")"
)"

MR_URL="$(jq -r '.web_url // empty' <<<"$MR_JSON")"
MR_IID="$(jq -r '.iid // empty' <<<"$MR_JSON")"

if [[ -z "$MR_URL" || -z "$MR_IID" ]]; then
    echo
    echo "ERROR: Merge request creation could not be verified."
    echo "$MR_JSON"
    exit 40
fi

# ============================================================
# Post implement notes as an MR comment
# ============================================================

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
echo "Merge request: $MR_URL"
if [[ -n "$NOTES_COMMENT_URL" ]]; then
    echo "Notes comment: $NOTES_COMMENT_URL"
fi
echo "Main log:      $LOG_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
