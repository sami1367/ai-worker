#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
ISSUE_NUMBER="${2:-}"

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/projects.conf"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/logs"

# shellcheck source=lib/common.sh
source "$BASE_DIR/lib/common.sh"
# shellcheck source=lib/ai.sh
source "$BASE_DIR/lib/ai.sh"

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

ai_init || exit 1

# ============================================================
# Resolve project
# ============================================================

PROJECT_DIR="$(
    awk -F= -v project="$PROJECT" '
        /^[[:space:]]*#/ { next }

        NF >= 2 && $1 == project {
            sub(/^[^=]*=/, "")
            print
            exit
        }
    ' "$PROJECTS_FILE"
)"

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

STATE_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}.running"

# Everything printed by this script also goes into the main log.
exec > >(tee -a "$LOG_FILE") 2>&1

BRANCH=""
REPO=""
ISSUE_TITLE=""
ISSUE_URL=""
PR_URL=""

# ============================================================
# Cleanup
#
# This ALWAYS attempts to put the repository back on main.
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

        if [[ "$current_branch" != "main" ]]; then

            if [[ -n "$(
                git -C "$PROJECT_DIR" status --porcelain \
                    2>/dev/null
            )" ]]; then

                echo "Discarding remaining task changes"
                echo "before returning to main..."

                echo
                echo "Changed files before cleanup:"

                git -C "$PROJECT_DIR" status --short || true

                git -C "$PROJECT_DIR" reset --hard HEAD || true

                # Removes untracked files created by the task.
                # Ignored files such as node_modules/vendor remain.
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo
            echo "Checking out main..."

            git -C "$PROJECT_DIR" checkout main || true
        fi

        # Remove local AI branch after returning to main.
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
ai_provider=$AI_PROVIDER
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
    echo "ERROR:"
    echo "Repository has uncommitted/untracked changes"
    echo "before starting."

    git -C "$PROJECT_DIR" status --short

    exit 10
fi

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

git -C "$PROJECT_DIR" checkout -b "$BRANCH" main

# ============================================================
# Build Cursor prompt
# ============================================================

cat > "$PROMPT_FILE" <<EOF
You are an autonomous senior software engineer working on a GitHub issue.

Repository: $REPO
Project directory: $PROJECT_DIR
GitHub issue: #$ISSUE_NUMBER
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
- run gh/GitHub CLI commands
- create, switch, delete, or modify branches
- create commits
- push code
- create or merge pull requests
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
- GitHub
- branches
- commits
- pushes
- labels
- pull requests

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
# Verify agent changed something
# ============================================================

echo
echo "Git status after AI agent:"

git -C "$PROJECT_DIR" status --short

if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then

    echo
    echo "ERROR:"
    echo "Cursor completed but made no changes."

    exit 20
fi

# ============================================================
# Stage changes
# ============================================================

echo
echo "Staging changes..."

git -C "$PROJECT_DIR" add -A

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

if grep -Eq \
    '(^|/)\.env($|\.)|(^|/).*\.pem$|(^|/).*\.key$|(^|/)id_rsa$|(^|/)id_ed25519$' \
    <<<"$CHANGED_FILES"; then

    echo
    echo "ERROR:"
    echo "A potential secret/private-key file is staged."
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

COMMIT_SHA="$(
    git -C "$PROJECT_DIR" rev-parse HEAD
)"

echo
echo "Commit:"
echo "$COMMIT_SHA"

# ============================================================
# Push
# ============================================================

echo
echo "Pushing branch..."

git -C "$PROJECT_DIR" push \
    -u origin "$BRANCH"

# ============================================================
# Create PR body
# ============================================================

PR_BODY_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}-pr.md"

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

# ============================================================
# Create Pull Request
# ============================================================

echo
echo "Creating pull request..."

gh pr create \
    --repo "$REPO" \
    --base main \
    --head "$BRANCH" \
    --title "Fix #${ISSUE_NUMBER}: ${ISSUE_TITLE}" \
    --body-file "$PR_BODY_FILE"

# Verify PR actually exists.
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
pull_request=$PR_URL
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
echo "Pull request: $PR_URL"
echo "Main log:     $LOG_FILE"
echo "Agent log:    $AGENT_LOG"
echo "Result file:  $RESULT_FILE"
echo "============================================================"
