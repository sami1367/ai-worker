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

CURSOR_BIN="$(ai_detect_cursor)" || exit 1

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
CURSOR_LOG="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.cursor.ndjson"
CURSOR_ERR_LOG="$LOG_DIR/${PROJECT}-gitlab-issue-${ISSUE_NUMBER}-${TIMESTAMP}.cursor.stderr.log"
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
cursor_log=$CURSOR_LOG
EOF

ai_log_banner "CURSOR AI GITLAB ISSUE WORKER"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Forge:         gitlab"
echo "Host:          $GITLAB_HOST"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Project dir:   $PROJECT_DIR"
echo "Cursor binary: $CURSOR_BIN"
echo "Main log:      $LOG_FILE"
echo "Cursor log:    $CURSOR_LOG"
echo "Cursor stderr: $CURSOR_ERR_LOG"
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
# Build Cursor prompt
# ============================================================

cat > "$PROMPT_FILE" <<EOF
You are an autonomous senior software engineer working on a GitLab issue.

Repository: $REPO_PATH
GitLab host: $GITLAB_HOST
Project directory: $PROJECT_DIR
GitLab issue: #$ISSUE_NUMBER
Issue URL: $ISSUE_URL

============================================================
ISSUE TITLE
============================================================

$ISSUE_TITLE

============================================================
ISSUE DESCRIPTION
============================================================

$ISSUE_BODY

============================================================
YOUR JOB
============================================================

Implement this issue completely and carefully.

You are running unattended.

Do not ask questions.
Do not ask for confirmation.
Do not wait for user approval.

Use your engineering judgment when the issue is clear enough
to implement.

You MAY:

- inspect and search repository files
- modify source code
- add or update tests
- run project tests
- run linting and formatting
- run build/type-check commands
- install project dependencies when genuinely required

You MUST NOT:

- run git commands
- call the GitLab API
- create, switch, delete, or modify branches
- create commits
- push code
- create or merge merge requests
- change git remotes
- read, print, or modify .env files
- reveal passwords
- reveal tokens
- reveal API keys
- reveal SSH keys
- reveal other secrets
- make unrelated changes
- modify production infrastructure unless the issue explicitly requires it
- modify database schema unless the issue explicitly requires it

A separate automation script handles:

- Git
- GitLab
- branches
- commits
- pushes
- labels
- merge requests

Leave your completed code changes in the working tree when finished.

============================================================
PROCESS
============================================================

1. Inspect the relevant architecture and existing implementation.

2. Inspect existing tests and project conventions.

3. Implement the issue using the smallest reasonable scope.

4. Add or update tests where appropriate.

5. Run the tests relevant to your changes.

6. Run appropriate lint, formatting, type-check, or build commands.

7. Fix failures caused by your implementation.

8. Review all files you changed.

9. Make sure no unrelated files were changed.

10. Leave all completed changes UNCOMMITTED in the working tree.

If a test fails because of the environment and cannot reasonably
be fixed, clearly report that in your final response.

Do not silently claim tests passed when they did not run or failed.

============================================================
FINAL RESPONSE
============================================================

At the end report:

Summary:

Files changed:

Tests run and results:

Lint / format / type-check / build results:

Problems or limitations:
EOF

# ============================================================
# Run Cursor
# ============================================================

ai_log_banner "STARTING CURSOR AGENT"
echo "Branch:        $BRANCH"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Cursor log:    $CURSOR_LOG"
echo "Cursor stderr: $CURSOR_ERR_LOG"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"

set +e

"$CURSOR_BIN" \
    --workspace "$PROJECT_DIR" \
    --force \
    --trust \
    --print \
    --output-format stream-json \
    --stream-partial-output \
    "$(cat "$PROMPT_FILE")" \
    2> >(tee -a "$CURSOR_ERR_LOG" >&2) \
    | tee -a "$CURSOR_LOG"

AGENT_EXIT_CODE=${PIPESTATUS[0]}

set -e

ai_log_banner "CURSOR AGENT FINISHED"
echo "Exit code: $AGENT_EXIT_CODE"
echo "Finished:  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"

if [[ "$AGENT_EXIT_CODE" -ne 0 ]]; then
    echo
    echo "ERROR: Cursor Agent failed."
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
cursor_log=$CURSOR_LOG
cursor_stderr=$CURSOR_ERR_LOG
EOF

ai_log_banner "ISSUE COMPLETE"
echo "Forge:         gitlab"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Branch:        $BRANCH"
echo "Commit:        $COMMIT_SHA"
echo "Merge request: $MR_URL"
echo "Main log:      $LOG_FILE"
echo "Cursor log:    $CURSOR_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
