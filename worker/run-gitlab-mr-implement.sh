#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
MR_IID="${2:-}"

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
NOTES_SAVED="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}-notes.md"
RELATED_TASKS_SAVED="$LOG_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}-${TIMESTAMP}-related-tasks.json"
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-mr-implement-${MR_IID}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO_PATH=""
MR_TITLE=""
MR_URL=""
SOURCE_BRANCH=""
TARGET_BRANCH=""
NOTES_FILE=""
RELATED_TASKS_FILE=""
NOTES_COMMENT_URL=""

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

    if [[ -n "${NOTES_FILE:-}" ]]; then
        rm -f "$NOTES_FILE"
    fi
    ai_remove_ai_artifact_files "$PROJECT_DIR" 2>/dev/null || true

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

NOTES_FILE="$PROJECT_DIR/.ai-mr-notes.md"
rm -f "$NOTES_FILE"
RELATED_TASKS_FILE="$PROJECT_DIR/.ai-related-tasks.json"
rm -f "$RELATED_TASKS_FILE"

ai_prompt_clear
ai_prompt_set REPO_PATH "$REPO_PATH"
ai_prompt_set GITLAB_HOST "$GITLAB_HOST"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set MR_IID "$MR_IID"
ai_prompt_set MR_URL "$MR_URL"
ai_prompt_set SOURCE_BRANCH "$SOURCE_BRANCH"
ai_prompt_set TARGET_BRANCH "$TARGET_BRANCH"
ai_prompt_set MR_TITLE "$MR_TITLE"
ai_prompt_set MR_BODY "$MR_BODY"
ai_prompt_set MR_COMMENTS_TEXT "$MR_COMMENTS_TEXT"
ai_prompt_set LINKED_ISSUES "$(cat "$ISSUES_FILE")"
ai_prompt_set NOTES_FILE "$NOTES_FILE"
ai_prompt_set RELATED_TASKS_FILE "$RELATED_TASKS_FILE"
ai_prompt_set SOURCE_PROJECT "$PROJECT"
ai_prompt_set REGISTERED_PROJECTS "$(ai_registered_projects_text)"

ai_prompt_render "gitlab-mr-implement.txt" "$PROMPT_FILE"

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

ai_capture_implement_notes "$NOTES_FILE" "$NOTES_SAVED" || true
ai_capture_related_tasks_file "$RELATED_TASKS_FILE" "$RELATED_TASKS_SAVED" || true

DECLINED_NO_CHANGES=0
if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    if ai_notes_explain_no_implementation "$NOTES_SAVED"; then
        DECLINED_NO_CHANGES=1
        echo "Agent declined the request (no product-file changes)."
        echo "Posting the explanation on the existing merge request; no new commit."
        COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
    else
        echo "ERROR: Agent completed but made no changes."
        exit 20
    fi
fi

if [[ "$DECLINED_NO_CHANGES" -eq 0 ]]; then
    ai_apply_related_tasks \
        "$RELATED_TASKS_SAVED" \
        "$PROJECT" \
        "GitLab merge request !${MR_IID} (${MR_URL})" \
        "${MR_BODY}"$'\n'"$(cat "$ISSUES_FILE" 2>/dev/null || true)" || true

    git -C "$PROJECT_DIR" add -A
    ai_unstage_ai_artifact_files "$PROJECT_DIR"
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
notes_file=$NOTES_SAVED
notes_comment=$NOTES_COMMENT_URL
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
if [[ -n "$NOTES_COMMENT_URL" ]]; then
    echo "Notes comment: $NOTES_COMMENT_URL"
fi
echo "============================================================"
