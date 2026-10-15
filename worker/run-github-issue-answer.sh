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

ai_require_cmds git gh jq tee || exit 1

if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI is not authenticated."
    echo "Run: gh auth login"
    exit 1
fi

ai_init || exit 1

# ============================================================
# Resolve project
# ============================================================

PROJECT_ENTRY="$(ai_resolve_project_entry "$PROJECTS_FILE" "$PROJECT")" || true
PROJECT_DIR="$(jq -r '.path // empty' <<<"${PROJECT_ENTRY:-}")"
DEFAULT_BRANCH="$(ai_project_default_branch "${PROJECT_ENTRY:-}")"

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

LOG_FILE="$LOG_DIR/${PROJECT}-issue-answer-${ISSUE_NUMBER}-${TIMESTAMP}.log"
AGENT_LOG="$LOG_DIR/${PROJECT}-issue-answer-${ISSUE_NUMBER}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-issue-answer-${ISSUE_NUMBER}-${TIMESTAMP}.agent.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-issue-answer-${ISSUE_NUMBER}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-issue-answer-${ISSUE_NUMBER}-${TIMESTAMP}.result.txt"
ANSWER_FILE="$PROJECT_DIR/.ai-issue-answer.md"
ANSWER_SAVED="$LOG_DIR/${PROJECT}-issue-answer-${ISSUE_NUMBER}-${TIMESTAMP}-answer.md"
STATE_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO=""
ISSUE_TITLE=""
ISSUE_URL=""

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
        if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then
            echo "Discarding leftover working-tree changes..."
            git -C "$PROJECT_DIR" status --short || true
            git -C "$PROJECT_DIR" reset --hard HEAD || true
            git -C "$PROJECT_DIR" clean -fd || true
        fi

        current_branch="$(
            git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
        )"
        if [[ "$current_branch" != "$DEFAULT_BRANCH" ]]; then
            echo "Checking out $DEFAULT_BRANCH..."
            git -C "$PROJECT_DIR" checkout "$DEFAULT_BRANCH" || true
        fi
    fi

    rm -f "$ANSWER_FILE"
    ai_remove_ai_artifact_files "$PROJECT_DIR" 2>/dev/null || true
    rm -f "$STATE_FILE"

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
mode=no-change
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
ai_provider=$AI_PROVIDER
EOF

ai_log_banner "AI GITHUB ISSUE ANSWER (NO-CHANGE)"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Project dir:   $PROJECT_DIR"
echo "Main log:      $LOG_FILE"
echo "============================================================"

# ============================================================
# Determine GitHub repository
# ============================================================

REPO="$(
    cd "$PROJECT_DIR"
    gh repo view --json nameWithOwner --jq '.nameWithOwner'
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
printf 'branch=%s\n' "$DEFAULT_BRANCH" >> "$STATE_FILE"

# ============================================================
# Read GitHub issue
# ============================================================

echo
echo "Reading GitHub issue #$ISSUE_NUMBER..."

ISSUE_JSON="$(
    gh issue view "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --json title,body,url,state,labels
)"

ISSUE_TITLE="$(jq -r '.title // ""' <<<"$ISSUE_JSON")"
ISSUE_BODY="$(jq -r '.body // ""' <<<"$ISSUE_JSON")"
ISSUE_URL="$(jq -r '.url // ""' <<<"$ISSUE_JSON")"
ISSUE_STATE="$(jq -r '.state // ""' <<<"$ISSUE_JSON")"

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

HAS_NO_CHANGE="$(
    jq -r '[.labels[].name | ascii_downcase] | any(. == "no-change")' <<<"$ISSUE_JSON"
)"
if [[ "$HAS_NO_CHANGE" != "true" ]]; then
    echo
    echo "ERROR: Issue is missing the no-change label."
    exit 13
fi

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
# Build AI prompt
# ============================================================

rm -f "$ANSWER_FILE"

ai_prompt_clear
ai_prompt_load_repo_custom "$PROJECTS_FILE" "$PROJECT"
ai_prompt_set REPO "$REPO"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set ISSUE_NUMBER "$ISSUE_NUMBER"
ai_prompt_set ISSUE_URL "$ISSUE_URL"
ai_prompt_set ISSUE_TITLE "$ISSUE_TITLE"
ai_prompt_set ISSUE_BODY "$ISSUE_BODY"
ai_prompt_set ISSUE_COMMENTS_TEXT "$ISSUE_COMMENTS_TEXT"
ai_prompt_set ANSWER_FILE "$ANSWER_FILE"

ai_prompt_render "github-issue-answer.txt" "$PROMPT_FILE"

# ============================================================
# Run AI agent (read-only answer)
# ============================================================

ai_log_agent_start "STARTING AI AGENT (ISSUE ANSWER / NO-CHANGE)"
echo "Branch:        main"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Answer file:   $ANSWER_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Agent stderr:  $AGENT_ERR_LOG"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"

ai_run_agent "$PROJECT_DIR" "$PROMPT_FILE" "$AGENT_LOG" "$AGENT_ERR_LOG" review

ai_log_agent_finish

if [[ "$AGENT_EXIT_CODE" -ne 0 ]]; then
    echo
    echo "ERROR: AI agent failed."
    exit "$AGENT_EXIT_CODE"
fi

# ============================================================
# Read answer output
# ============================================================

if [[ ! -f "$ANSWER_FILE" ]]; then
    echo
    echo "ERROR: Answer file was not created: $ANSWER_FILE"
    exit 20
fi

ANSWER_BODY="$(cat "$ANSWER_FILE")"

if [[ -z "$(printf '%s' "$ANSWER_BODY" | tr -d '[:space:]')" ]]; then
    echo
    echo "ERROR: Answer file is empty."
    exit 21
fi

cp "$ANSWER_FILE" "$ANSWER_SAVED"
echo
echo "Answer file bytes: $(wc -c < "$ANSWER_FILE" | tr -d ' ')"

ai_log_phase "VALIDATE" "no-change answer: allow only .ai-issue-answer.md"
# Reject accidental product-file edits (answer artifact alone is OK).
ai_assert_only_allowed_changes "$PROJECT_DIR" ".ai-issue-answer.md" \
    || exit $?

# ============================================================
# Post issue comment (trusted orchestration — forge credentials available here)
# ============================================================

ai_log_phase "PUBLISH" "Posting issue answer comment via gh (orchestration)"

COMMENT_FILE="$(mktemp)"
{
    cat "$ANSWER_FILE"
    cat <<EOF

---
_Label \`ai\` + \`no-change\` was processed automatically. Re-add \`ai\` (keep \`no-change\`) to ask again._
EOF
} > "$COMMENT_FILE"

ai_validate_forge_text_file "$COMMENT_FILE" 200000 0 || exit 40

echo
echo "Posting answer comment to issue #$ISSUE_NUMBER..."

COMMENT_URL="$(
    gh issue comment "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --body-file "$COMMENT_FILE"
)"

rm -f "$COMMENT_FILE"

if [[ -z "$COMMENT_URL" ]]; then
    echo
    echo "ERROR: Could not verify issue comment creation."
    exit 40
fi

echo "Comment posted: $COMMENT_URL"

# ============================================================
# Save result
# ============================================================

cat > "$RESULT_FILE" <<EOF
forge=github
project=$PROJECT
repository=$REPO
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
mode=no-change
comment_url=$COMMENT_URL
labels=ai-answered,no-change
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
answer_file=$ANSWER_SAVED
result_file=$RESULT_FILE
EOF

ai_log_banner "ISSUE ANSWER COMPLETE"
echo "Forge:        github"
echo "Project:      $PROJECT"
echo "Issue:        #$ISSUE_NUMBER"
echo "Comment:      $COMMENT_URL"
echo "Main log:     $LOG_FILE"
echo "Result file:  $RESULT_FILE"
echo "============================================================"
