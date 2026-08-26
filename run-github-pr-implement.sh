#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
PR_NUMBER="${2:-}"

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

if [[ -z "$PROJECT" || -z "$PR_NUMBER" ]]; then
    echo "Usage: $0 <project> <pull-request-number>"
    exit 1
fi

if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: pull request number must be numeric."
    exit 1
fi

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: GitHub projects file not found: $PROJECTS_FILE"
    exit 1
fi

ai_require_cmds git gh jq tee || exit 1

if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI is not authenticated."
    exit 1
fi

ai_init || exit 1

PROJECT_DIR="$(ai_resolve_project_dir "$PROJECTS_FILE" "$PROJECT")"

if [[ -z "$PROJECT_DIR" ]] || ! ai_validate_project_dir "$PROJECT" "$PROJECT_DIR"; then
    echo "ERROR: Invalid or unregistered project: $PROJECT"
    exit 1
fi

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

LOG_FILE="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}.log"
AGENT_LOG="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}.agent.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}.result.txt"
ISSUES_FILE="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}.issues.txt"
STATE_FILE="$STATE_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO=""
PR_TITLE=""
PR_URL=""
SOURCE_BRANCH=""
TARGET_BRANCH=""

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
                git -C "$PROJECT_DIR" reset --hard HEAD || true
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo "Checking out main..."
            git -C "$PROJECT_DIR" checkout main || true
        fi
    fi

    rm -f "$STATE_FILE"

    echo "Finished: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    exit "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$STATE_FILE" <<EOF
forge=github
task=pr-implement
project=$PROJECT
pull_request=$PR_NUMBER
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "AI GITHUB PR IMPLEMENT"
echo "Project:       $PROJECT"
echo "Pull request:  #$PR_NUMBER"
echo "Project dir:   $PROJECT_DIR"
echo "AI provider:   $AI_PROVIDER_NAME ($AI_PROVIDER)"
echo "Main log:      $LOG_FILE"
echo "============================================================"

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo "ERROR: Repository has uncommitted changes before starting."
    exit 10
fi

REPO="$(
    cd "$PROJECT_DIR"
    gh repo view --json nameWithOwner --jq '.nameWithOwner'
)"

if [[ -z "$REPO" ]]; then
    echo "ERROR: Could not determine GitHub repository."
    exit 11
fi

echo "Repository: $REPO"

PR_JSON="$(
    gh pr view "$PR_NUMBER" \
        --repo "$REPO" \
        --json title,body,url,state,headRefName,baseRefName
)"

PR_TITLE="$(jq -r '.title' <<<"$PR_JSON")"
PR_BODY="$(jq -r '.body // ""' <<<"$PR_JSON")"
PR_URL="$(jq -r '.url' <<<"$PR_JSON")"
PR_STATE="$(jq -r '.state' <<<"$PR_JSON")"
SOURCE_BRANCH="$(jq -r '.headRefName' <<<"$PR_JSON")"
TARGET_BRANCH="$(jq -r '.baseRefName' <<<"$PR_JSON")"

echo "Title:  $PR_TITLE"
echo "State:  $PR_STATE"
echo "Source: $SOURCE_BRANCH"
echo "URL:    $PR_URL"

if [[ "$PR_STATE" != "OPEN" ]]; then
    echo "Pull request is not open. Nothing to do."
    exit 0
fi

echo "Fetching pull request comments..."
PR_COMMENTS_TEXT="$(ai_github_format_pr_discussion "$REPO" "$PR_NUMBER")"

echo "Building linked issues file..."
LINKED_ISSUE_COUNT=0
ai_build_github_linked_issues_file "$REPO" "$PR_TITLE" "$PR_BODY" "$ISSUES_FILE" LINKED_ISSUE_COUNT

echo "Fetching origin..."
git -C "$PROJECT_DIR" fetch --prune origin

echo "Checking out source branch: $SOURCE_BRANCH"
if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$SOURCE_BRANCH"; then
    git -C "$PROJECT_DIR" checkout -B "$SOURCE_BRANCH" "origin/$SOURCE_BRANCH"
elif git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH"; then
    git -C "$PROJECT_DIR" checkout "$SOURCE_BRANCH"
    git -C "$PROJECT_DIR" pull --ff-only origin "$SOURCE_BRANCH" || true
else
    echo "ERROR: Source branch not found: $SOURCE_BRANCH"
    exit 13
fi

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo "ERROR: Working tree is not clean after checkout."
    exit 12
fi

{
    cat <<EOF
You are an autonomous senior software engineer updating an existing GitHub pull request branch.

Repository: $REPO
Project directory: $PROJECT_DIR
Pull request: #$PR_NUMBER
PR URL: $PR_URL
Source branch: $SOURCE_BRANCH
Target branch: $TARGET_BRANCH

You are checked out on the pull request source branch. Implement the requested changes on this branch.

============================================================
PR TITLE
============================================================

$PR_TITLE

============================================================
PR DESCRIPTION
============================================================

$PR_BODY

============================================================
PR COMMENTS / DISCUSSION (primary instructions — overrides title/description)
============================================================

$PR_COMMENTS_TEXT

$(ai_prompt_comments_priority_instructions)

============================================================
LINKED ISSUES / TASKS
============================================================

EOF
    cat "$ISSUES_FILE"
    cat <<EOF

============================================================
YOUR JOB
============================================================

Implement the work requested in the PR comments and linked issue comments.
Comments are the primary source of requirements; follow them over the PR/issue title and description.

You are running unattended. Do not ask questions or wait for approval.

You MAY inspect files, modify code, run tests, lint, and install dependencies when needed.

You MUST NOT run git/gh commands, create branches, commit, push, merge, or read .env files.

Leave completed changes UNCOMMITTED in the working tree.

============================================================
FINAL RESPONSE
============================================================

Report: Summary, files changed, tests run, problems/limitations.
EOF
} > "$PROMPT_FILE"

ai_log_agent_start "STARTING AI AGENT (PR IMPLEMENT)"
echo "Branch:        $SOURCE_BRANCH"
echo "Linked issues: $LINKED_ISSUE_COUNT"
echo "Prompt file:   $PROMPT_FILE"
echo "============================================================"

ai_run_agent "$PROJECT_DIR" "$PROMPT_FILE" "$AGENT_LOG" "$AGENT_ERR_LOG" implement
ai_log_agent_finish

if [[ "$AGENT_EXIT_CODE" -ne 0 ]]; then
    echo "ERROR: AI agent failed."
    exit "$AGENT_EXIT_CODE"
fi

git -C "$PROJECT_DIR" status --short

if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo "ERROR: Agent completed but made no changes."
    exit 20
fi

git -C "$PROJECT_DIR" add -A
CHANGED_FILES="$(git -C "$PROJECT_DIR" diff --cached --name-only)"

if ai_has_secret_files "$CHANGED_FILES"; then
    echo "ERROR: Potential secret file staged."
    exit 30
fi

if git -C "$PROJECT_DIR" diff --cached --quiet; then
    echo "ERROR: Nothing staged after agent changes."
    exit 21
fi

git -C "$PROJECT_DIR" commit -m "fix: address feedback on PR #${PR_NUMBER}"

COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

echo "Pushing branch $SOURCE_BRANCH..."
git -C "$PROJECT_DIR" push origin "$SOURCE_BRANCH"

cat > "$RESULT_FILE" <<EOF
forge=github
task=pr-implement
project=$PROJECT
repository=$REPO
pull_request=$PR_NUMBER
pull_request_url=$PR_URL
branch=$SOURCE_BRANCH
commit=$COMMIT_SHA
linked_issues=$LINKED_ISSUE_COUNT
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "PR IMPLEMENT COMPLETE"
echo "Pull request: #$PR_NUMBER"
echo "Branch:       $SOURCE_BRANCH"
echo "Commit:       $COMMIT_SHA"
echo "PR URL:       $PR_URL"
echo "============================================================"
