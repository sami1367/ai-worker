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

PROJECTS_FILE="$BASE_DIR/github-projects.conf"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/logs"

# shellcheck source=lib/common.sh
source "$WORKER_CODE_DIR/lib/common.sh"
# shellcheck source=lib/labels.sh
source "$WORKER_CODE_DIR/lib/labels.sh"
# shellcheck source=lib/prompts.sh
source "$WORKER_CODE_DIR/lib/prompts.sh"
# shellcheck source=lib/related-tasks.sh
source "$WORKER_CODE_DIR/lib/related-tasks.sh"
# shellcheck source=lib/ai.sh
source "$WORKER_CODE_DIR/lib/ai.sh"

mkdir -p "$STATE_DIR" "$LOG_DIR"
ai_load_env "$BASE_DIR/.env"

# ============================================================
# Validate input
# ============================================================

if [[ -z "$PROJECT" || -z "$ISSUE_NUMBER" ]]; then
    echo "Usage: $0 <project> <issue-number>"
    exit 1
fi

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: issue number must be numeric."
    exit 1
fi

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: Projects file not found: $PROJECTS_FILE"
    exit 1
fi

# ============================================================
# Required commands
# ============================================================

ai_require_cmds git gh jq tee || exit 1

# AI provider is initialized later — skipped for title "new release".

# ============================================================
# Resolve project
# ============================================================

PROJECT_ENTRY="$(ai_resolve_project_entry "$PROJECTS_FILE" "$PROJECT")" || true
PROJECT_DIR="$(jq -r '.path // empty' <<<"${PROJECT_ENTRY:-}")"
DEFAULT_BRANCH="$(ai_project_default_branch "${PROJECT_ENTRY:-}")"
FORCE_PUSH_TO_DEFAULT="$(ai_project_entry_bool "${PROJECT_ENTRY:-}" "force_push_to_default" 0)"
export CODEGRAPH_ENABLED="$(ai_project_entry_bool "${PROJECT_ENTRY:-}" "codegraph_enabled" 1)"

if [[ -z "$PROJECT_DIR" ]]; then
    echo "ERROR: Project is not registered: $PROJECT"
    exit 1
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "ERROR: Project directory does not exist:"
    echo "$PROJECT_DIR"
    exit 1
fi

if ! git -C "$PROJECT_DIR" rev-parse \
    --is-inside-work-tree >/dev/null 2>&1; then

    echo "ERROR: Not a Git repository:"
    echo "$PROJECT_DIR"
    exit 1
fi

# ============================================================
# Log files
# ============================================================

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

LOG_FILE="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.log"

AGENT_LOG="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.agent.stderr.log"

PROMPT_FILE="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.prompt.txt"

RESULT_FILE="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.result.txt"
NOTES_SAVED="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}-notes.md"
RELATED_TASKS_SAVED="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}-related-tasks.json"

STATE_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}.running"

# Everything printed by this script also goes into the main log.
exec > >(tee -a "$LOG_FILE") 2>&1

BRANCH=""
REPO=""
ISSUE_TITLE=""
ISSUE_URL=""
PR_URL=""
NOTES_FILE=""
RELATED_TASKS_FILE=""
NOTES_COMMENT_URL=""

# ============================================================
# Cleanup
#
# This ALWAYS attempts to put the repository back on the default branch.
# ============================================================

cleanup() {
    rc=$?

    trap - EXIT INT TERM
    set +e

    echo
    echo "============================================================"
    echo "                     CLEANUP"
    echo "============================================================"
    echo "Exit code: $rc"

    if git -C "$PROJECT_DIR" rev-parse \
        --is-inside-work-tree >/dev/null 2>&1; then

        current_branch="$(
            git -C "$PROJECT_DIR" branch --show-current \
                2>/dev/null || true
        )"

        if [[ "$current_branch" != "$DEFAULT_BRANCH" ]]; then

            if [[ -n "$(
                git -C "$PROJECT_DIR" status --porcelain \
                    2>/dev/null
            )" ]]; then

                echo "Discarding remaining task changes"
                echo "before returning to $DEFAULT_BRANCH..."

                echo
                echo "Changed files before cleanup:"

                git -C "$PROJECT_DIR" status --short || true

                git -C "$PROJECT_DIR" reset --hard HEAD || true

                # Removes untracked files created by the task.
                # Ignored files such as node_modules/vendor remain.
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo
            echo "Checking out $DEFAULT_BRANCH..."

            git -C "$PROJECT_DIR" checkout "$DEFAULT_BRANCH" || true
        fi

        # Remove local AI branch after returning to the default branch.
        #
        # The successful branch still exists on GitHub because it
        # was already pushed before the PR was created.
        if [[ -n "$BRANCH" ]] &&
           git -C "$PROJECT_DIR" show-ref \
               --verify --quiet "refs/heads/$BRANCH"; then

            if [[ "$(
                git -C "$PROJECT_DIR" branch --show-current \
                    2>/dev/null || true
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
        git -C "$PROJECT_DIR" branch --show-current \
            2>/dev/null || echo unknown
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
project=$PROJECT
issue=$ISSUE_NUMBER
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

# ============================================================
# Start information
# ============================================================

ai_log_banner "AI GITHUB ISSUE WORKER"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Default branch: $DEFAULT_BRANCH"
echo "Force-push:    $([[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]] && echo enabled || echo disabled)"
echo "Project dir:   $PROJECT_DIR"
echo "Main log:      $LOG_FILE"
echo "============================================================"

# ============================================================
# Determine GitHub repository
# ============================================================

REPO="$(
    cd "$PROJECT_DIR"

    gh repo view \
        --json nameWithOwner \
        --jq '.nameWithOwner'
)"

if [[ -z "$REPO" ]]; then
    echo "ERROR: Could not determine GitHub repository."
    exit 11
fi

echo
echo "Repository: $REPO"
ai_ensure_project_labels github "$REPO" "$PROJECT"
ai_configure_ssh_git_remote "$PROJECT_DIR"
echo "Origin: $(git -C "$PROJECT_DIR" remote get-url origin)"

# ============================================================
# Fresh environment: clean checkout of up-to-date default branch
# ============================================================

ai_prepare_fresh_branch "$PROJECT_DIR" "$DEFAULT_BRANCH" || exit $?

# ============================================================
# Read GitHub issue
# ============================================================

echo
echo "Reading GitHub issue #$ISSUE_NUMBER..."

ISSUE_JSON="$(
    gh issue view "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --json number,title,body,labels,state,url
)"

ISSUE_TITLE="$(
    jq -r '.title' <<<"$ISSUE_JSON"
)"

ISSUE_BODY="$(
    jq -r '.body // ""' <<<"$ISSUE_JSON"
)"

ISSUE_URL="$(
    jq -r '.url' <<<"$ISSUE_JSON"
)"

ISSUE_STATE="$(
    jq -r '.state' <<<"$ISSUE_JSON"
)"

echo
echo "Title: $ISSUE_TITLE"
echo "State: $ISSUE_STATE"
echo "URL:   $ISSUE_URL"

if [[ "$ISSUE_STATE" != "OPEN" ]]; then

    echo
    echo "Issue is not open."
    echo "Nothing to do."

    exit 0
fi

# ============================================================
# Special case: title "new release" or "new tag"
#
# Skip the AI agent. Sync the repo, then bump past the highest
# vMAJOR.MINOR.PATCH already used by either a git tag or a
# GitHub release (including drafts — draft releases often have
# no fetchable git tag yet), push a real git tag (so tag-based
# Actions CI runs), and create a draft GitHub release on that tag.
# ============================================================

ISSUE_TITLE_NORM="$(ai_normalize_issue_title "$ISSUE_TITLE")"

if ai_is_new_release_title "$ISSUE_TITLE"; then

    ai_log_banner "NEW RELEASE / NEW TAG (NO AI)"
    echo "Issue title matches '$ISSUE_TITLE_NORM'."
    echo "Skipping AI agent; pushing next git tag + draft GitHub release."
    echo "============================================================"

    echo
    echo "Fetching all tags from origin..."

    git -C "$PROJECT_DIR" fetch --tags --prune origin

    LATEST_GIT_TAG="$(ai_latest_git_semver_tag "$PROJECT_DIR")"
    echo "Latest git tag:     ${LATEST_GIT_TAG:-<none>}"

    echo
    echo "Checking GitHub releases (including drafts)..."

    LATEST_RELEASE_TAG="$(
        gh release list --repo "$REPO" --limit 100 --json tagName \
            --jq '.[].tagName' |
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

    # Keep bumping if a local tag or GitHub release already claims the candidate
    # (race / stale draft without a git tag).
    while ai_git_tag_exists "$PROJECT_DIR" "$NEW_TAG" ||
          gh release view "$NEW_TAG" --repo "$REPO" >/dev/null 2>&1; do
        echo "Candidate $NEW_TAG already exists; bumping patch again..."
        NEW_TAG="$(ai_bump_semver_patch "$NEW_TAG")"
    done

    TAG_COMMIT="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

    echo
    echo "Latest used: $LATEST_TAG"
    echo "New tag:     $NEW_TAG"
    echo "Tag commit:  $TAG_COMMIT"

    # Push a real git tag first. Draft-only `gh release create --draft` does
    # not create a fetchable tag (untagged-… URLs), so tag-triggered Actions
    # never run. Pushing the tag triggers `on: push: tags: v*` workflows.
    echo
    echo "Creating local git tag $NEW_TAG at $TAG_COMMIT..."
    if ! git -C "$PROJECT_DIR" tag "$NEW_TAG" "$TAG_COMMIT"; then
        echo
        echo "ERROR: Failed to create local git tag $NEW_TAG."
        exit 52
    fi

    echo "Pushing tag $NEW_TAG to origin..."
    if ! git -C "$PROJECT_DIR" push origin "refs/tags/${NEW_TAG}"; then
        echo
        echo "ERROR: Failed to push tag $NEW_TAG to origin."
        git -C "$PROJECT_DIR" tag -d "$NEW_TAG" >/dev/null 2>&1 || true
        exit 53
    fi

    echo
    echo "Creating draft release on existing tag: $NEW_TAG"
    echo "Command: gh release create $NEW_TAG --repo $REPO --draft --generate-notes --target $TAG_COMMIT"

    RELEASE_URL="$(
        gh release create "$NEW_TAG" \
            --repo "$REPO" \
            --draft \
            --generate-notes \
            --target "$TAG_COMMIT"
    )"

    if [[ -z "$RELEASE_URL" ]]; then
        echo
        echo "ERROR: gh release create did not return a release URL."
        echo "Git tag $NEW_TAG was already pushed (CI may already be running)."
        exit 54
    fi

    echo
    echo "Draft release created:"
    echo "$RELEASE_URL"

    COMMENT_BODY="$(cat <<EOF
## Automated draft release

Skipped the AI agent because this issue title is \`$ISSUE_TITLE_NORM\`.

- Previous tag: \`$LATEST_TAG\`
- New git tag: \`$NEW_TAG\` (\`$TAG_COMMIT\`)
- New draft release: \`$NEW_TAG\`
- URL: $RELEASE_URL

The git tag was pushed so tag-based GitHub Actions can run. Publish the draft on GitHub when you are ready. This automation never publishes releases automatically.
EOF
)"

    echo
    echo "Commenting on issue #$ISSUE_NUMBER..."
    gh issue comment "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --body "$COMMENT_BODY"

    echo
    echo "Closing issue #$ISSUE_NUMBER..."
    gh issue close "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --comment "Closed after creating draft release $NEW_TAG."

    cat > "$RESULT_FILE" <<EOF
forge=github
project=$PROJECT
repository=$REPO
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
mode=new-release
previous_tag=$LATEST_TAG
new_tag=$NEW_TAG
tag_commit=$TAG_COMMIT
release_url=$RELEASE_URL
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
EOF

    ai_log_banner "RELEASE COMPLETE"
    echo "Forge:        github"
    echo "Project:      $PROJECT"
    echo "Issue:        #$ISSUE_NUMBER"
    echo "Previous tag: $LATEST_TAG"
    echo "New tag:      $NEW_TAG"
    echo "Tag commit:   $TAG_COMMIT"
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

ISSUE_COMMENTS_JSON="$(ai_github_fetch_issue_comments "$REPO" "$ISSUE_NUMBER")"
ISSUE_COMMENTS_COUNT="$(jq 'length' <<<"$ISSUE_COMMENTS_JSON")"
ISSUE_COMMENTS_TEXT="$(ai_format_github_comments "$ISSUE_COMMENTS_JSON")"

echo "Comments: $ISSUE_COMMENTS_COUNT"

# ============================================================
# Create branch
# ============================================================

BASE_BRANCH="ai/issue-${ISSUE_NUMBER}"
BRANCH="$BASE_BRANCH"

# If the branch already exists locally or remotely,
# create a timestamped branch instead.
if git -C "$PROJECT_DIR" show-ref \
       --verify --quiet "refs/heads/$BRANCH" ||
   git -C "$PROJECT_DIR" show-ref \
       --verify --quiet "refs/remotes/origin/$BRANCH"; then

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

NOTES_FILE="$PROJECT_DIR/.ai-pr-notes.md"
rm -f "$NOTES_FILE"
RELATED_TASKS_FILE="$PROJECT_DIR/.ai-related-tasks.json"
rm -f "$RELATED_TASKS_FILE"

ai_prompt_clear
ai_prompt_load_repo_custom "$PROJECTS_FILE" "$PROJECT"
ai_prompt_set REPO "$REPO"
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

ai_prompt_render "github-issue-implement.txt" "$PROMPT_FILE"

# ============================================================
# Run AI agent
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
# Verify agent changed something (trusted validation — no agent shell)
# ============================================================

ai_log_phase "VALIDATE" "Inspect workspace diffs; secret-file gate before publish"

echo
echo "Git status after AI agent:"

git -C "$PROJECT_DIR" status --short

# Capture merge/PR notes before staging so they are never committed.
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
            echo "Opening an empty-commit pull request with the explanation."
        fi
    else
        echo
        echo "ERROR:"
        echo "Cursor completed but made no changes."
        exit 20
    fi
fi

if [[ "$DECLINED_NO_CHANGES" -eq 0 ]]; then
    ai_apply_related_tasks \
        "$RELATED_TASKS_SAVED" \
        "$PROJECT" \
        "GitHub issue #${ISSUE_NUMBER} (${ISSUE_URL})" \
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
        git -C "$PROJECT_DIR" diff \
            --cached \
            --name-only
    )"

    echo
    echo "Files to commit:"

    printf '%s\n' "$CHANGED_FILES"

    # ============================================================
    # Basic secret/private-key protection
    # ============================================================

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
# Commit / publish (PR or force-push) — trusted orchestration only
# ============================================================

ai_log_phase "PUBLISH" "Commit/push/PR via orchestration with forge credentials"

PR_URL=""
PR_NUMBER=""
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

    COMMIT_SHA="$(
        git -C "$PROJECT_DIR" rev-parse HEAD
    )"

    echo
    echo "Commit:"
    echo "$COMMIT_SHA"
fi

if [[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]]; then
    if [[ "$DECLINED_NO_CHANGES" -eq 0 ]]; then
        echo
        echo "Force-pushing commit to origin/$DEFAULT_BRANCH (skipping pull request)..."
        git -C "$PROJECT_DIR" push --force origin "HEAD:refs/heads/${DEFAULT_BRANCH}"

        # Align local default branch with what we just published.
        git -C "$PROJECT_DIR" fetch origin "$DEFAULT_BRANCH" || true
        git -C "$PROJECT_DIR" checkout -B "$DEFAULT_BRANCH" "origin/$DEFAULT_BRANCH"
        git -C "$PROJECT_DIR" reset --hard "origin/$DEFAULT_BRANCH"
        BRANCH="$DEFAULT_BRANCH"
        printf 'branch=%s\n' "$BRANCH" >> "$STATE_FILE"
    fi

    ISSUE_COMMENT_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}-force-push-comment.md"
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

Changes were force-pushed directly to \`${DEFAULT_BRANCH}\` (pull request skipped for this repository).

**Branch:** \`${DEFAULT_BRANCH}\`

**Commit:** \`$COMMIT_SHA\`

Closes #$ISSUE_NUMBER
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
    NOTES_COMMENT_URL="$(
        gh issue comment "$ISSUE_NUMBER" \
            --repo "$REPO" \
            --body-file "$ISSUE_COMMENT_FILE" || true
    )"
    if [[ -z "$NOTES_COMMENT_URL" ]]; then
        echo "WARNING: Issue comment was not posted."
    fi
else
    # ============================================================
    # Push task branch + create pull request
    # ============================================================

    echo
    echo "Pushing branch..."

    git -C "$PROJECT_DIR" push \
        -u origin "$BRANCH"

    PR_BODY_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}-pr.md"

    if [[ "$DECLINED_NO_CHANGES" -eq 1 ]]; then
        cat > "$PR_BODY_FILE" <<EOF
## Not implemented

This pull request contains **no product-file changes**. The agent judged the issue unrelated to this repository, not acceptable, or not useful to implement.

**Issue:** $ISSUE_URL

**Branch:** \`$BRANCH\`

**Commit:** \`$COMMIT_SHA\`

Related to #$ISSUE_NUMBER

### Why this was not implemented

$(cat "$NOTES_SAVED")

The automation never merges pull requests automatically.
EOF
    else
        cat > "$PR_BODY_FILE" <<EOF
## Automated implementation

This pull request was created automatically by the server-side Cursor issue worker.

**Issue:** $ISSUE_URL

**Branch:** \`$BRANCH\`

**Commit:** \`$COMMIT_SHA\`

Closes #$ISSUE_NUMBER

### Review note

Please review the implementation and CI results before merging.

The automation never merges pull requests automatically.
EOF
    fi

    echo
    echo "Creating pull request..."

    if [[ "$DECLINED_NO_CHANGES" -eq 1 ]]; then
        PR_TITLE="No changes for #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
    else
        PR_TITLE="Fix #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
    fi

    # Attach ai-pr at create time (parity with GitLab). Label must already exist
    # (ai_ensure_project_labels ran earlier). Avoid unlabeled PRs that would not
    # block the next issue via block_on_open_pr.
    ai_ensure_project_labels github "$REPO" "$PROJECT"

    # PR metadata is built by orchestration (trusted branch/base); validate body only.
    ai_validate_forge_text_file "$PR_BODY_FILE" 200000 0 || exit 40

    if ! gh pr create \
        --repo "$REPO" \
        --base "$DEFAULT_BRANCH" \
        --head "$BRANCH" \
        --title "$PR_TITLE" \
        --body-file "$PR_BODY_FILE" \
        --label "ai-pr"; then
        echo "WARNING: gh pr create --label ai-pr failed; creating PR then attaching label."
        gh pr create \
            --repo "$REPO" \
            --base "$DEFAULT_BRANCH" \
            --head "$BRANCH" \
            --title "$PR_TITLE" \
            --body-file "$PR_BODY_FILE"
    fi

    PR_URL="$(
        gh pr view "$BRANCH" \
            --repo "$REPO" \
            --json url \
            --jq '.url'
    )"

    if [[ -z "$PR_URL" ]]; then
        echo
        echo "ERROR:"
        echo "Pull request creation could not be verified."
        exit 40
    fi

    PR_NUMBER="$(
        gh pr view "$BRANCH" \
            --repo "$REPO" \
            --json number \
            --jq '.number'
    )"

    echo
    echo "Ensuring pull request has label ai-pr..."
    if ! github_ensure_pr_has_ai_pr_label "$REPO" "$PR_NUMBER"; then
        echo "WARNING: Pull request #$PR_NUMBER may be missing ai-pr; open ai/issue-* PRs still block new issues."
    fi

    if [[ -f "$NOTES_SAVED" ]]; then
        if NOTES_COMMENT_URL="$(ai_post_github_pr_notes "$REPO" "$PR_NUMBER" "$NOTES_SAVED")"; then
            :
        else
            NOTES_COMMENT_URL=""
            echo "WARNING: Implement notes comment was not posted."
        fi
    else
        echo "WARNING: No implement notes file to post as a PR comment."
    fi
fi

# ============================================================
# Save result
# ============================================================

cat > "$RESULT_FILE" <<EOF
project=$PROJECT
repository=$REPO
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
branch=$BRANCH
commit=$COMMIT_SHA
force_push_to_default=$FORCE_PUSH_TO_DEFAULT
pull_request=$PR_URL
notes_file=$NOTES_SAVED
notes_comment=$NOTES_COMMENT_URL
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "ISSUE COMPLETE"
echo "Project:      $PROJECT"
echo "Issue:        #$ISSUE_NUMBER"
echo "Branch:       $BRANCH"
echo "Commit:       $COMMIT_SHA"
if [[ "$FORCE_PUSH_TO_DEFAULT" == "1" ]]; then
    echo "Published:    force-push to origin/$DEFAULT_BRANCH"
else
    echo "Pull request: $PR_URL"
fi
if [[ -n "$NOTES_COMMENT_URL" ]]; then
    echo "Notes comment: $NOTES_COMMENT_URL"
fi
echo "Main log:     $LOG_FILE"
echo "Agent log:    $AGENT_LOG"
echo "Result file:  $RESULT_FILE"
echo "============================================================"
