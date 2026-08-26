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

ai_init || exit 1

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
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

BRANCH=""
REPO_PATH=""
ISSUE_TITLE=""
ISSUE_URL=""
MR_URL=""

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
ai_provider=$AI_PROVIDER
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
echo "AI provider:   $AI_PROVIDER_NAME ($AI_PROVIDER)"
echo "AI binary:     $AI_PROVIDER_BIN"
echo "Main log:      $LOG_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Agent stderr:  $AGENT_ERR_LOG"
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

ai_prompt_clear
ai_prompt_set REPO_PATH "$REPO_PATH"
ai_prompt_set GITLAB_HOST "$GITLAB_HOST"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set ISSUE_NUMBER "$ISSUE_NUMBER"
ai_prompt_set ISSUE_URL "$ISSUE_URL"
ai_prompt_set ISSUE_TITLE "$ISSUE_TITLE"
ai_prompt_set ISSUE_BODY "$ISSUE_BODY"
ai_prompt_set ISSUE_COMMENTS_TEXT "$ISSUE_COMMENTS_TEXT"

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

if [[ -z "$MR_URL" ]]; then
    echo
    echo "ERROR: Merge request creation could not be verified."
    echo "$MR_JSON"
    exit 40
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
echo "Main log:      $LOG_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
