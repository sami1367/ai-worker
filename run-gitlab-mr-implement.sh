#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
MR_IID="${2:-}"

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/gitlab-projects.conf"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/logs"

# shellcheck source=lib/common.sh
source "$BASE_DIR/lib/common.sh"
# shellcheck source=lib/ai.sh
source "$BASE_DIR/lib/ai.sh"
# shellcheck source=lib/gitlab.sh
source "$BASE_DIR/lib/gitlab.sh"

mkdir -p "$STATE_DIR" "$LOG_DIR"
ai_load_env "$BASE_DIR/.env"

if [[ -z "$PROJECT" || -z "$MR_IID" ]]; then
    echo "Usage: $0 <project> <merge-request-iid>"
    exit 1
fi

if [[ ! "$MR_IID" =~ ^[0-9]+$ ]]; then
    echo "ERROR: merge request iid must be numeric."
    exit 1
fi

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: GitLab projects file not found: $PROJECTS_FILE"
    exit 1
fi

if ! gitlab_configured; then
    echo "ERROR: GITLAB_TOKEN is not set."
    exit 1
fi

ai_require_cmds git curl jq tee || exit 1
ai_init || exit 1

PROJECT_DIR="$(ai_resolve_project_dir "$PROJECTS_FILE" "$PROJECT")"

if [[ -z "$PROJECT_DIR" ]] || ! ai_validate_project_dir "$PROJECT" "$PROJECT_DIR"; then
    echo "ERROR: Invalid or unregistered project: $PROJECT"
    exit 1
fi

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

LOG_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}.log"
AGENT_LOG="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}.agent.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}.result.txt"
ISSUES_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}.issues.txt"
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO_PATH=""
MR_TITLE=""
MR_URL=""
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
forge=gitlab
task=mr-implement
project=$PROJECT
merge_request=$MR_IID
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "AI GITLAB MR IMPLEMENT"
echo "Project:       $PROJECT"
echo "Merge request: !$MR_IID"
echo "Project dir:   $PROJECT_DIR"
echo "AI provider:   $AI_PROVIDER_NAME ($AI_PROVIDER)"
echo "Main log:      $LOG_FILE"
echo "============================================================"

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo "ERROR: Repository has uncommitted changes before starting."
    exit 10
fi

REPO_PATH="$(gitlab_resolve_project_path "$PROJECT_DIR")" || true

if [[ -z "$REPO_PATH" ]]; then
    echo "ERROR: Could not determine GitLab project path."
    exit 11
fi

echo "GitLab project: $REPO_PATH"

MR_JSON="$(gitlab_get_mr "$REPO_PATH" "$MR_IID")"

MR_TITLE="$(jq -r '.title' <<<"$MR_JSON")"
MR_BODY="$(jq -r '.description // ""' <<<"$MR_JSON")"
MR_URL="$(jq -r '.web_url' <<<"$MR_JSON")"
MR_STATE="$(jq -r '.state' <<<"$MR_JSON")"
SOURCE_BRANCH="$(jq -r '.source_branch' <<<"$MR_JSON")"
TARGET_BRANCH="$(jq -r '.target_branch' <<<"$MR_JSON")"

echo "Title:  $MR_TITLE"
echo "State:  $MR_STATE"
echo "Source: $SOURCE_BRANCH"
echo "URL:    $MR_URL"

if [[ "$MR_STATE" != "opened" ]]; then
    echo "Merge request is not open. Nothing to do."
    exit 0
fi

echo "Fetching merge request comments..."
MR_NOTES_JSON="$(gitlab_list_mr_notes "$REPO_PATH" "$MR_IID")"
MR_COMMENTS_TEXT="$(gitlab_format_notes "$MR_NOTES_JSON")"

echo "Building linked issues file..."
LINKED_ISSUE_COUNT=0
ai_build_gitlab_linked_issues_file "$REPO_PATH" "$MR_TITLE" "$MR_BODY" "$ISSUES_FILE" LINKED_ISSUE_COUNT

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
You are an autonomous senior software engineer updating an existing GitLab merge request branch.

Repository: $REPO_PATH
GitLab host: $GITLAB_HOST
Project directory: $PROJECT_DIR
Merge request: !$MR_IID
MR URL: $MR_URL
Source branch: $SOURCE_BRANCH
Target branch: $TARGET_BRANCH

You are checked out on the merge request source branch. Implement the requested changes on this branch.

============================================================
MR TITLE
============================================================

$MR_TITLE

============================================================
MR DESCRIPTION
============================================================

$MR_BODY

============================================================
MR COMMENTS / DISCUSSION (primary instructions — overrides title/description)
============================================================

$MR_COMMENTS_TEXT

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

Implement the work requested in the MR comments and linked issue comments.
Comments are the primary source of requirements; follow them over the MR/issue title and description.

You are running unattended. Do not ask questions or wait for approval.

You MAY inspect files, modify code, run tests, lint, and install dependencies when needed.

You MUST NOT run git commands, call the GitLab API, create branches, commit, push, merge, or read .env files.

Leave completed changes UNCOMMITTED in the working tree.

============================================================
FINAL RESPONSE
============================================================

Report: Summary, files changed, tests run, problems/limitations.
EOF
} > "$PROMPT_FILE"

ai_log_agent_start "STARTING AI AGENT (MR IMPLEMENT)"
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

git -C "$PROJECT_DIR" commit -m "fix: address feedback on MR !${MR_IID}"

COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

echo "Pushing branch $SOURCE_BRANCH..."
git -C "$PROJECT_DIR" push origin "$SOURCE_BRANCH"

cat > "$RESULT_FILE" <<EOF
forge=gitlab
task=mr-implement
project=$PROJECT
repository=$REPO_PATH
merge_request=$MR_IID
merge_request_url=$MR_URL
branch=$SOURCE_BRANCH
commit=$COMMIT_SHA
linked_issues=$LINKED_ISSUE_COUNT
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "MR IMPLEMENT COMPLETE"
echo "Merge request: !$MR_IID"
echo "Branch:        $SOURCE_BRANCH"
echo "Commit:        $COMMIT_SHA"
echo "MR URL:        $MR_URL"
echo "============================================================"
