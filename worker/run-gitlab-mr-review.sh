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
# shellcheck source=lib/ai.sh
source "$WORKER_CODE_DIR/lib/ai.sh"
# shellcheck source=lib/gitlab.sh
source "$WORKER_CODE_DIR/lib/gitlab.sh"
# shellcheck source=lib/labels.sh
source "$WORKER_CODE_DIR/lib/labels.sh"

mkdir -p "$STATE_DIR" "$LOG_DIR"
ai_load_env "$BASE_DIR/.env"

# ============================================================
# Validate input
# ============================================================

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

LOG_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.log"
AGENT_LOG="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.agent.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.result.txt"
REVIEW_FILE="$PROJECT_DIR/.ai-mr-review.md"
DIFF_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.diff.txt"
ISSUES_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.issues.txt"
COMMENTS_RAW_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.comments-raw.json"
COMMENTS_ITEMS_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.discussion-items.json"
COMMENTS_FULL_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.comments-full.txt"
COMMENTS_SINCE_AI_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.comments-since-ai.txt"
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-mr-${MR_IID}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO_PATH=""
MR_TITLE=""
MR_URL=""
SOURCE_BRANCH=""
TARGET_BRANCH=""
LABELS_CLAIMED=0
LABELS_FINALIZED=0

# ============================================================
# Cleanup
# ============================================================

cleanup() {
    rc=$?

    trap - EXIT INT TERM
    set +e

    ai_log_banner "CLEANUP"
    echo "Exit code: $rc"

    # If we claimed the MR for review but never finished successfully, mark failed.
    if [[ "$LABELS_CLAIMED" -eq 1 && "$LABELS_FINALIZED" -eq 0 && "$rc" -ne 0 && -n "$REPO_PATH" ]]; then
        echo "Updating labels: ai-reviewing -> ai-review-failed"
        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --add "ai-review-failed" \
            --remove "ai-reviewing" \
            || echo "WARNING: Could not set ai-review-failed label."
    fi

    rm -f "$REVIEW_FILE"

    if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then

        if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then
            echo "Discarding local changes before returning to main..."
            git -C "$PROJECT_DIR" status --short || true
            git -C "$PROJECT_DIR" reset --hard HEAD || true
            git -C "$PROJECT_DIR" clean -fd || true
        fi

        current_branch="$(
            git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
        )"

        if [[ "$current_branch" != "main" ]]; then
            echo
            echo "Checking out main..."
            git -C "$PROJECT_DIR" checkout main || true
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
merge_request=$MR_IID
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "AI GITLAB MR REVIEW"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Forge:         gitlab"
echo "Host:          $GITLAB_HOST"
echo "Project:       $PROJECT"
echo "Merge request: !$MR_IID"
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
ai_configure_ssh_git_remote "$PROJECT_DIR"
echo "Origin: $(git -C "$PROJECT_DIR" remote get-url origin)"

# ============================================================
# Read merge request
# ============================================================

echo
echo "Reading GitLab merge request !$MR_IID..."

MR_JSON="$(gitlab_get_mr "$REPO_PATH" "$MR_IID")"

MR_TITLE="$(jq -r '.title' <<<"$MR_JSON")"
MR_BODY="$(jq -r '.description // ""' <<<"$MR_JSON")"
MR_URL="$(jq -r '.web_url' <<<"$MR_JSON")"
MR_STATE="$(jq -r '.state' <<<"$MR_JSON")"
SOURCE_BRANCH="$(jq -r '.source_branch' <<<"$MR_JSON")"
TARGET_BRANCH="$(jq -r '.target_branch' <<<"$MR_JSON")"
AUTHOR="$(jq -r '.author.username // .author.name // "unknown"' <<<"$MR_JSON")"

echo
echo "Title:  $MR_TITLE"
echo "State:  $MR_STATE"
echo "Author: $AUTHOR"
echo "Source: $SOURCE_BRANCH"
echo "Target: $TARGET_BRANCH"
echo "URL:    $MR_URL"

printf 'branch=%s\n' "$SOURCE_BRANCH" >> "$STATE_FILE"

if [[ "$MR_STATE" != "opened" ]]; then
    echo
    echo "Merge request is not open."
    echo "Nothing to do."
    exit 0
fi

# ============================================================
# Claim MR review labels
# ============================================================

echo
echo "Updating labels: ai-review -> ai-reviewing"

if gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
    --add "ai-reviewing" \
    --remove "ai-review"; then
    LABELS_CLAIMED=1
else
    echo "WARNING: Could not set ai-reviewing (continuing review anyway)."
    # Still treat as claimed so cleanup can set ai-review-failed on errors.
    LABELS_CLAIMED=1
fi

gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
    --remove "ai-review-failed" \
    >/dev/null 2>&1 || true

gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
    --remove "ai-reviewed" \
    >/dev/null 2>&1 || true

# ============================================================
# MR comments / discussion
# ============================================================

echo
echo "Fetching merge request comments..."

MR_NOTES_JSON="$(gitlab_list_mr_notes "$REPO_PATH" "$MR_IID")"
printf '%s' "$MR_NOTES_JSON" > "$COMMENTS_RAW_FILE"

MR_NOTES_RAW_COUNT="$(jq 'length' <<<"${MR_NOTES_JSON:-[]}")"
echo "Raw MR notes from GitLab API: $MR_NOTES_RAW_COUNT"

MR_DISCUSSION_ITEMS="$(ai_gitlab_discussion_items_from_notes "$REPO_PATH" "$MR_NOTES_JSON")"
printf '%s' "$MR_DISCUSSION_ITEMS" > "$COMMENTS_ITEMS_FILE"

ai_log_latest_discussion_comment "$MR_DISCUSSION_ITEMS" "GitLab MR !$MR_IID"

MR_COMMENTS_COUNT="$(jq 'length' <<<"$MR_DISCUSSION_ITEMS")"
ai_split_discussion_items_to_files "$MR_DISCUSSION_ITEMS" "$COMMENTS_FULL_FILE" "$COMMENTS_SINCE_AI_FILE" AI_REVIEW_ROUNDS

MR_COMMENTS_TEXT="$(cat "$COMMENTS_FULL_FILE")"
MR_SINCE_AI_COMMENTS_TEXT="$(cat "$COMMENTS_SINCE_AI_FILE")"

echo "MR comments: $MR_COMMENTS_COUNT"
echo "Prior AI review rounds in thread: $AI_REVIEW_ROUNDS"
echo "Comment diagnostics files:"
echo "  Raw GitLab notes JSON:     $COMMENTS_RAW_FILE"
echo "  Normalized discussion:     $COMMENTS_ITEMS_FILE"
echo "  Full thread (prompt):      $COMMENTS_FULL_FILE"
echo "  Since last AI (prompt):    $COMMENTS_SINCE_AI_FILE"

ai_log_discussion_items_table "$MR_DISCUSSION_ITEMS" "MR DISCUSSION TIMELINE (index = order in thread)"
ai_log_human_comments_since_last_ai "$MR_DISCUSSION_ITEMS"

echo
echo "SINCE_LAST_AI_COMMENTS_TEXT bytes: $(wc -c < "$COMMENTS_SINCE_AI_FILE" | tr -d ' ')"
echo "Preview (first 800 chars of since-last-AI section sent to AI):"
head -c 800 "$COMMENTS_SINCE_AI_FILE" || true
echo
echo "--- end preview ---"

# ============================================================
# Linked issues from MR description (Closes/Fixes/Related to #N)
# ============================================================

echo
echo "Looking for linked issues in MR title/description..."

: > "$ISSUES_FILE"
LINKED_ISSUE_COUNT=0

mapfile -t LINKED_ISSUE_IIDS < <(
    gitlab_extract_linked_issue_iids "${MR_TITLE}"$'\n'"${MR_BODY}"
)

if [[ ${#LINKED_ISSUE_IIDS[@]} -eq 0 ]]; then
    echo "No linked issues found (no Closes/Fixes/Related to #N refs)."
    cat >> "$ISSUES_FILE" <<EOF
No linked GitLab issues were found in the MR title or description.

Review the merge request on its own merits from the title, description, and diff.
EOF
else
    echo "Found linked issue(s): $(printf '#%s ' "${LINKED_ISSUE_IIDS[@]}")"

    for issue_iid in "${LINKED_ISSUE_IIDS[@]}"; do
        echo "Fetching issue #${issue_iid}..."

        if ! ISSUE_JSON="$(gitlab_get_issue "$REPO_PATH" "$issue_iid" 2>/dev/null)"; then
            echo "WARNING: Could not fetch issue #${issue_iid}."
            cat >> "$ISSUES_FILE" <<EOF
------------------------------------------------------------
ISSUE #${issue_iid}
------------------------------------------------------------

(Could not fetch this issue from the GitLab API.)

EOF
            continue
        fi

        LINKED_ISSUE_COUNT=$((LINKED_ISSUE_COUNT + 1))

        ISSUE_TITLE="$(jq -r '.title // ""' <<<"$ISSUE_JSON")"
        ISSUE_STATE="$(jq -r '.state // ""' <<<"$ISSUE_JSON")"
        ISSUE_URL="$(jq -r '.web_url // ""' <<<"$ISSUE_JSON")"
        ISSUE_AUTHOR="$(jq -r '.author.username // .author.name // "unknown"' <<<"$ISSUE_JSON")"
        ISSUE_LABELS="$(jq -r '[.labels[]?] | join(", ")' <<<"$ISSUE_JSON")"
        ISSUE_BODY="$(jq -r '.description // ""' <<<"$ISSUE_JSON")"

        ISSUE_COMMENTS_TEXT="(no comments)"
        if ISSUE_NOTES_JSON="$(gitlab_list_issue_notes "$REPO_PATH" "$issue_iid" 2>/dev/null)"; then
            ISSUE_COMMENTS_TEXT="$(gitlab_format_notes "$ISSUE_NOTES_JSON" 10000 "$REPO_PATH")"
        fi

        # Cap very long issue bodies so the prompt stays usable.
        ISSUE_BODY_BYTES="$(printf '%s' "$ISSUE_BODY" | wc -c | tr -d ' ')"
        if [[ "$ISSUE_BODY_BYTES" -gt 20000 ]]; then
            ISSUE_BODY="$(printf '%s' "$ISSUE_BODY" | head -c 20000)
... [issue description truncated] ..."
        fi

        echo "  #$issue_iid — $ISSUE_TITLE ($ISSUE_STATE)"

        cat >> "$ISSUES_FILE" <<EOF
------------------------------------------------------------
ISSUE #${issue_iid}
------------------------------------------------------------

Title:  $ISSUE_TITLE
State:  $ISSUE_STATE
Author: $ISSUE_AUTHOR
Labels: ${ISSUE_LABELS:-none}
URL:    $ISSUE_URL

Description:
$ISSUE_BODY

Comments (override description when they conflict):
$ISSUE_COMMENTS_TEXT

EOF
    done
fi

# ============================================================
# Fetch MR changes / diff summary
# ============================================================

echo
echo "Fetching merge request changes..."

CHANGES_JSON="$(gitlab_get_mr_changes "$REPO_PATH" "$MR_IID")"

# Build a readable diff summary for the prompt (cap size so the prompt stays usable).
jq -r '
  (.changes // [])
  | map(
      "### " + (.old_path // .new_path // "unknown")
      + (if .new_file then " (new)" elif .deleted_file then " (deleted)" elif .renamed_file then " (renamed)" else "" end)
      + "\n\n```diff\n"
      + ((.diff // "") | .[0:12000])
      + (if ((.diff // "") | length) > 12000 then "\n... [diff truncated] ..." else "" end)
      + "\n```\n"
    )
  | join("\n")
' <<<"$CHANGES_JSON" > "$DIFF_FILE"

DIFF_BYTES="$(wc -c < "$DIFF_FILE" | tr -d ' ')"
echo "Diff summary bytes: $DIFF_BYTES"

# Truncate whole prompt diff section if enormous.
if [[ "$DIFF_BYTES" -gt 200000 ]]; then
    echo "Diff is large; truncating prompt attachment to 200KB..."
    head -c 200000 "$DIFF_FILE" > "${DIFF_FILE}.part"
    echo -e "\n\n... [remaining diffs truncated for prompt size] ..." >> "${DIFF_FILE}.part"
    mv "${DIFF_FILE}.part" "$DIFF_FILE"
fi

# ============================================================
# Update remotes and check out source branch (read-only review)
# ============================================================

ai_fetch_and_checkout_source_branch "$PROJECT_DIR" "$SOURCE_BRANCH" || exit $?

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    echo
    echo "ERROR: Working tree is not clean after checkout."
    git -C "$PROJECT_DIR" status --short
    exit 12
fi

# ============================================================
# Build AI prompt
# ============================================================

rm -f "$REVIEW_FILE"

ai_prompt_clear
ai_prompt_load_repo_custom "$PROJECTS_FILE" "$PROJECT"
ai_prompt_set REPO_PATH "$REPO_PATH"
ai_prompt_set GITLAB_HOST "$GITLAB_HOST"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set MR_IID "$MR_IID"
ai_prompt_set MR_URL "$MR_URL"
ai_prompt_set AUTHOR "$AUTHOR"
ai_prompt_set SOURCE_BRANCH "$SOURCE_BRANCH"
ai_prompt_set TARGET_BRANCH "$TARGET_BRANCH"
ai_prompt_set MR_TITLE "$MR_TITLE"
ai_prompt_set MR_BODY "$MR_BODY"
ai_prompt_set MR_COMMENTS_TEXT "$MR_COMMENTS_TEXT"
ai_prompt_set SINCE_LAST_AI_COMMENTS_TEXT "$MR_SINCE_AI_COMMENTS_TEXT"
ai_prompt_set LINKED_ISSUES "$(cat "$ISSUES_FILE")"
ai_prompt_set DIFF "$(cat "$DIFF_FILE")"
ai_prompt_set REVIEW_FILE "$REVIEW_FILE"

ai_prompt_render "gitlab-mr-review.txt" "$PROMPT_FILE"

# ============================================================
# Run Cursor
# ============================================================

ai_log_agent_start "STARTING AI AGENT (MR REVIEW)"
echo "Branch:        $SOURCE_BRANCH"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Review file:   $REVIEW_FILE"
echo "Linked issues: $LINKED_ISSUE_COUNT"
echo "MR comments:   $MR_COMMENTS_COUNT"
echo "AI review rounds: $AI_REVIEW_ROUNDS"
echo "Issues file:   $ISSUES_FILE"
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
# Read review output
# ============================================================

if [[ ! -f "$REVIEW_FILE" ]]; then
    echo
    echo "ERROR: Review file was not created: $REVIEW_FILE"
    exit 20
fi

REVIEW_BODY="$(cat "$REVIEW_FILE")"

if [[ -z "$(printf '%s' "$REVIEW_BODY" | tr -d '[:space:]')" ]]; then
    echo
    echo "ERROR: Review file is empty."
    exit 21
fi

echo
echo "Review file bytes: $(wc -c < "$REVIEW_FILE" | tr -d ' ')"

# ============================================================
# Post MR comment
# ============================================================

COMMENT_BODY="$(
    {
        cat "$REVIEW_FILE"
        cat <<EOF

---
_Label \`ai-review\` was processed automatically. Re-add \`ai-review\` to request another review._
EOF
    }
)"

echo
echo "Posting review comment to merge request !$MR_IID..."

NOTE_JSON="$(
    gitlab_create_mr_note "$REPO_PATH" "$MR_IID" "$COMMENT_BODY"
)"

NOTE_ID="$(jq -r '.id // empty' <<<"$NOTE_JSON")"

if [[ -z "$NOTE_ID" ]]; then
    echo
    echo "ERROR: Could not verify MR note creation."
    echo "$NOTE_JSON"
    exit 40
fi

NOTE_URL="$(jq -r '.web_url // empty' <<<"$NOTE_JSON")"

echo "Comment posted (note id: $NOTE_ID)"
if [[ -n "$NOTE_URL" ]]; then
    echo "Comment URL: $NOTE_URL"
fi

# ============================================================
# Finalize MR review labels
# ============================================================

echo
echo "Updating labels: ai-reviewing -> ai-reviewed"

if gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
    --add "ai-reviewed" \
    --remove "ai-reviewing"; then
    LABELS_FINALIZED=1
else
    echo "ERROR: Could not set ai-reviewed label."
    exit 41
fi

gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
    --remove "ai-review-failed" \
    >/dev/null 2>&1 || true

# ============================================================
# Save result
# ============================================================

cat > "$RESULT_FILE" <<EOF
forge=gitlab
project=$PROJECT
repository=$REPO_PATH
merge_request=$MR_IID
merge_request_url=$MR_URL
source_branch=$SOURCE_BRANCH
target_branch=$TARGET_BRANCH
note_id=$NOTE_ID
note_url=$NOTE_URL
labels=ai-reviewed
linked_issues=$LINKED_ISSUE_COUNT
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
comments_raw=$COMMENTS_RAW_FILE
comments_items=$COMMENTS_ITEMS_FILE
comments_full=$COMMENTS_FULL_FILE
comments_since_ai=$COMMENTS_SINCE_AI_FILE
prompt_file=$PROMPT_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "MR REVIEW COMPLETE"
echo "Forge:         gitlab"
echo "Project:       $PROJECT"
echo "Merge request: !$MR_IID"
echo "MR URL:        $MR_URL"
echo "Note id:       $NOTE_ID"
echo "Linked issues: $LINKED_ISSUE_COUNT"
echo "Labels:        ai-reviewed"
echo "Main log:      $LOG_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
