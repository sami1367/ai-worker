#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
PR_NUMBER="${2:-}"

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

PROJECT_ENTRY="$(ai_resolve_project_entry "$PROJECTS_FILE" "$PROJECT")" || true
PROJECT_DIR="$(jq -r '.path // empty' <<<"${PROJECT_ENTRY:-}")"
DEFAULT_BRANCH="$(ai_project_default_branch "${PROJECT_ENTRY:-}")"

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
NOTES_SAVED="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}-notes.md"
RELATED_TASKS_SAVED="$LOG_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}-${TIMESTAMP}-related-tasks.json"
STATE_FILE="$STATE_DIR/${PROJECT}-github-pr-implement-${PR_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO=""
PR_TITLE=""
PR_URL=""
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

        if [[ "$current_branch" != "$DEFAULT_BRANCH" ]]; then
            if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then
                echo "Discarding remaining task changes before returning to $DEFAULT_BRANCH..."
                git -C "$PROJECT_DIR" reset --hard HEAD || true
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo "Checking out $DEFAULT_BRANCH..."
            git -C "$PROJECT_DIR" checkout "$DEFAULT_BRANCH" || true
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

ai_discard_local_changes "$PROJECT_DIR"

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

printf 'branch=%s\n' "$SOURCE_BRANCH" >> "$STATE_FILE"

if [[ "$PR_STATE" != "OPEN" ]]; then
    echo "Pull request is not open. Nothing to do."
    exit 0
fi

echo "Fetching pull request comments..."
PR_COMMENTS_TEXT="$(ai_github_format_pr_discussion "$REPO" "$PR_NUMBER")"

echo "Building linked issues file..."
LINKED_ISSUE_COUNT=0
ai_build_github_linked_issues_file "$REPO" "$PR_TITLE" "$PR_BODY" "$ISSUES_FILE" LINKED_ISSUE_COUNT

ai_configure_ssh_git_remote "$PROJECT_DIR"
ai_fetch_and_checkout_source_branch "$PROJECT_DIR" "$SOURCE_BRANCH" || exit $?

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo "ERROR: Working tree is not clean after checkout."
    exit 12
fi

NOTES_FILE="$PROJECT_DIR/.ai-pr-notes.md"
rm -f "$NOTES_FILE"
RELATED_TASKS_FILE="$PROJECT_DIR/.ai-related-tasks.json"
rm -f "$RELATED_TASKS_FILE"

ai_prompt_clear
ai_prompt_load_repo_custom "$PROJECTS_FILE" "$PROJECT"
ai_prompt_set REPO "$REPO"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set PR_NUMBER "$PR_NUMBER"
ai_prompt_set PR_URL "$PR_URL"
ai_prompt_set SOURCE_BRANCH "$SOURCE_BRANCH"
ai_prompt_set TARGET_BRANCH "$TARGET_BRANCH"
ai_prompt_set PR_TITLE "$PR_TITLE"
ai_prompt_set PR_BODY "$PR_BODY"
ai_prompt_set PR_COMMENTS_TEXT "$PR_COMMENTS_TEXT"
ai_prompt_set LINKED_ISSUES "$(cat "$ISSUES_FILE")"
ai_prompt_set NOTES_FILE "$NOTES_FILE"
ai_prompt_set RELATED_TASKS_FILE "$RELATED_TASKS_FILE"
ai_prompt_set SOURCE_PROJECT "$PROJECT"
ai_prompt_set REGISTERED_PROJECTS "$(ai_registered_projects_text)"

ai_prompt_render "github-pr-implement.txt" "$PROMPT_FILE"

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

ai_log_phase "VALIDATE" "Inspect workspace diffs; secret-file gate before publish"

git -C "$PROJECT_DIR" status --short

ai_capture_implement_notes "$NOTES_FILE" "$NOTES_SAVED" || true
ai_capture_related_tasks_file "$RELATED_TASKS_FILE" "$RELATED_TASKS_SAVED" || true

DECLINED_NO_CHANGES=0
if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    if ai_notes_explain_no_implementation "$NOTES_SAVED"; then
        DECLINED_NO_CHANGES=1
        echo "Agent declined the request (no product-file changes)."
        echo "Posting the explanation on the existing pull request; no new commit."
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
        "GitHub pull request #${PR_NUMBER} (${PR_URL})" \
        "${PR_BODY}"$'\n'"$(cat "$ISSUES_FILE" 2>/dev/null || true)" || true

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

    ai_log_phase "PUBLISH" "Commit/push source branch via orchestration"

    git -C "$PROJECT_DIR" commit -m "fix: address feedback on PR #${PR_NUMBER}"

    COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

    echo "Pushing branch $SOURCE_BRANCH..."
    git -C "$PROJECT_DIR" push origin "$SOURCE_BRANCH"
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
notes_file=$NOTES_SAVED
notes_comment=$NOTES_COMMENT_URL
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
if [[ -n "$NOTES_COMMENT_URL" ]]; then
    echo "Notes comment: $NOTES_COMMENT_URL"
fi
echo "============================================================"
