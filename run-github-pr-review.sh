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
# shellcheck source=lib/prompts.sh
source "$BASE_DIR/lib/prompts.sh"
# shellcheck source=lib/ai.sh
source "$BASE_DIR/lib/ai.sh"

mkdir -p "$STATE_DIR" "$LOG_DIR"
ai_load_env "$BASE_DIR/.env"

# ============================================================
# Validate input
# ============================================================

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
    echo "Run: gh auth login"
    exit 1
fi

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

LOG_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.log"
AGENT_LOG="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.agent.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.result.txt"
REVIEW_FILE="$PROJECT_DIR/.ai-pr-review.md"
DIFF_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.diff.txt"
ISSUES_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.issues.txt"
COMMENTS_ITEMS_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.discussion-items.json"
COMMENTS_FULL_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.comments-full.txt"
COMMENTS_SINCE_AI_FILE="$LOG_DIR/${PROJECT}-github-pr-${PR_NUMBER}-${TIMESTAMP}.comments-since-ai.txt"
STATE_FILE="$STATE_DIR/${PROJECT}-github-pr-${PR_NUMBER}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO=""
PR_TITLE=""
PR_URL=""
SOURCE_BRANCH=""
TARGET_BRANCH=""
LABELS_CLAIMED=0
LABELS_FINALIZED=0

# ============================================================
# Helpers
# ============================================================

# Extract unique issue numbers linked from PR title/description.
# Recognizes GitHub-style refs, e.g.:
#   Closes #1
#   Fixes #123
#   Related to #45
#   Resolves #7
github_extract_linked_issue_numbers() {
    local text="$1"
    local matches

    if [[ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]]; then
        return 0
    fi

    matches="$(
        printf '%s\n' "$text" \
            | grep -oiE \
                '(closes?|closed|closing|fixes?|fixed|fixing|resolves?|resolved|resolving|implements?|implemented|implementing|related[[:space:]]+to|relates[[:space:]]+to)[[:space:]]+#[[:digit:]]+' \
            || true
    )"

    if [[ -z "$matches" ]]; then
        return 0
    fi

    printf '%s\n' "$matches" | grep -oE '[[:digit:]]+' | sort -n -u
}

# ============================================================
# Cleanup
# ============================================================

cleanup() {
    rc=$?

    trap - EXIT INT TERM
    set +e

    ai_log_banner "CLEANUP"
    echo "Exit code: $rc"

    # If we claimed the PR for review but never finished successfully, mark failed.
    if [[ "$LABELS_CLAIMED" -eq 1 && "$LABELS_FINALIZED" -eq 0 && "$rc" -ne 0 && -n "$REPO" ]]; then
        echo "Updating labels: ai-reviewing -> ai-review-failed"
        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-review-failed" \
            --remove-label "ai-reviewing" \
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
forge=github
project=$PROJECT
pull_request=$PR_NUMBER
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "AI GITHUB PR REVIEW"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Forge:         github"
echo "Project:       $PROJECT"
echo "Pull request:  #$PR_NUMBER"
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
# Determine GitHub repository
# ============================================================

REPO="$(
    cd "$PROJECT_DIR"
    gh repo view --json nameWithOwner --jq '.nameWithOwner'
)"

if [[ -z "$REPO" ]]; then
    echo "ERROR: Could not determine GitHub repository from local clone."
    exit 11
fi

echo
echo "GitHub repository: $REPO"
echo "Origin: $(git -C "$PROJECT_DIR" remote get-url origin)"

# ============================================================
# Read pull request
# ============================================================

echo
echo "Reading GitHub pull request #$PR_NUMBER..."

PR_JSON="$(
    gh pr view "$PR_NUMBER" \
        --repo "$REPO" \
        --json title,body,url,state,headRefName,baseRefName,author
)"

PR_TITLE="$(jq -r '.title' <<<"$PR_JSON")"
PR_BODY="$(jq -r '.body // ""' <<<"$PR_JSON")"
PR_URL="$(jq -r '.url' <<<"$PR_JSON")"
PR_STATE="$(jq -r '.state' <<<"$PR_JSON")"
SOURCE_BRANCH="$(jq -r '.headRefName' <<<"$PR_JSON")"
TARGET_BRANCH="$(jq -r '.baseRefName' <<<"$PR_JSON")"
AUTHOR="$(jq -r '.author.login // .author.name // "unknown"' <<<"$PR_JSON")"

echo
echo "Title:  $PR_TITLE"
echo "State:  $PR_STATE"
echo "Author: $AUTHOR"
echo "Source: $SOURCE_BRANCH"
echo "Target: $TARGET_BRANCH"
echo "URL:    $PR_URL"

if [[ "$PR_STATE" != "OPEN" ]]; then
    echo
    echo "Pull request is not open."
    echo "Nothing to do."
    exit 0
fi

# ============================================================
# Claim PR review labels
# ============================================================

echo
echo "Updating labels: ai-review -> ai-reviewing"

if gh pr edit "$PR_NUMBER" \
    --repo "$REPO" \
    --add-label "ai-reviewing" \
    --remove-label "ai-review"; then
    LABELS_CLAIMED=1
else
    echo "WARNING: Could not set ai-reviewing (continuing review anyway)."
    # Still treat as claimed so cleanup can set ai-review-failed on errors.
    LABELS_CLAIMED=1
fi

gh pr edit "$PR_NUMBER" \
    --repo "$REPO" \
    --remove-label "ai-review-failed" \
    >/dev/null 2>&1 || true

gh pr edit "$PR_NUMBER" \
    --repo "$REPO" \
    --remove-label "ai-reviewed" \
    >/dev/null 2>&1 || true

# ============================================================
# PR comments / discussion
# ============================================================

echo
echo "Fetching pull request comments..."

PR_DISCUSSION_ITEMS="$(ai_github_discussion_items_from_pr "$REPO" "$PR_NUMBER")"
printf '%s' "$PR_DISCUSSION_ITEMS" > "$COMMENTS_ITEMS_FILE"

PR_COMMENTS_COUNT="$(jq 'length' <<<"$PR_DISCUSSION_ITEMS")"
ai_split_discussion_items_to_files "$PR_DISCUSSION_ITEMS" "$COMMENTS_FULL_FILE" "$COMMENTS_SINCE_AI_FILE" AI_REVIEW_ROUNDS

PR_COMMENTS_TEXT="$(cat "$COMMENTS_FULL_FILE")"
PR_SINCE_AI_COMMENTS_TEXT="$(cat "$COMMENTS_SINCE_AI_FILE")"

echo "PR discussion items: $PR_COMMENTS_COUNT"
echo "Prior AI review rounds in thread: $AI_REVIEW_ROUNDS"
echo "Comment diagnostics files:"
echo "  Normalized discussion:     $COMMENTS_ITEMS_FILE"
echo "  Full thread (prompt):      $COMMENTS_FULL_FILE"
echo "  Since last AI (prompt):    $COMMENTS_SINCE_AI_FILE"

ai_log_discussion_items_table "$PR_DISCUSSION_ITEMS" "PR DISCUSSION TIMELINE (index = order in thread)"
ai_log_human_comments_since_last_ai "$PR_DISCUSSION_ITEMS"

echo
echo "SINCE_LAST_AI_COMMENTS_TEXT bytes: $(wc -c < "$COMMENTS_SINCE_AI_FILE" | tr -d ' ')"
echo "Preview (first 800 chars of since-last-AI section sent to AI):"
head -c 800 "$COMMENTS_SINCE_AI_FILE" || true
echo
echo "--- end preview ---"

# ============================================================
# Linked issues from PR description (Closes/Fixes/Related to #N)
# ============================================================

echo
echo "Looking for linked issues in PR title/description..."

: > "$ISSUES_FILE"
LINKED_ISSUE_COUNT=0

mapfile -t LINKED_ISSUE_NUMBERS < <(
    github_extract_linked_issue_numbers "${PR_TITLE}"$'\n'"${PR_BODY}"
)

if [[ ${#LINKED_ISSUE_NUMBERS[@]} -eq 0 ]]; then
    echo "No linked issues found (no Closes/Fixes/Related to #N refs)."
    cat >> "$ISSUES_FILE" <<EOF
No linked GitHub issues were found in the PR title or description.

Review the pull request on its own merits from the title, description, and diff.
EOF
else
    echo "Found linked issue(s): $(printf '#%s ' "${LINKED_ISSUE_NUMBERS[@]}")"

    for issue_number in "${LINKED_ISSUE_NUMBERS[@]}"; do
        echo "Fetching issue #${issue_number}..."

        if ! ISSUE_JSON="$(
            gh issue view "$issue_number" \
                --repo "$REPO" \
                --json title,body,url,state,author,labels \
                2>/dev/null
        )"; then
            echo "WARNING: Could not fetch issue #${issue_number}."
            cat >> "$ISSUES_FILE" <<EOF
------------------------------------------------------------
ISSUE #${issue_number}
------------------------------------------------------------

(Could not fetch this issue from the GitHub API.)

EOF
            continue
        fi

        LINKED_ISSUE_COUNT=$((LINKED_ISSUE_COUNT + 1))

        ISSUE_TITLE="$(jq -r '.title // ""' <<<"$ISSUE_JSON")"
        ISSUE_STATE="$(jq -r '.state // ""' <<<"$ISSUE_JSON")"
        ISSUE_URL="$(jq -r '.url // ""' <<<"$ISSUE_JSON")"
        ISSUE_AUTHOR="$(jq -r '.author.login // .author.name // "unknown"' <<<"$ISSUE_JSON")"
        ISSUE_LABELS="$(jq -r '[.labels[].name] | join(", ")' <<<"$ISSUE_JSON")"
        ISSUE_BODY="$(jq -r '.body // ""' <<<"$ISSUE_JSON")"

        ISSUE_COMMENTS_TEXT="(no comments)"
        if ISSUE_COMMENTS_JSON="$(ai_github_fetch_issue_comments "$REPO" "$issue_number" 2>/dev/null)"; then
            ISSUE_COMMENTS_TEXT="$(ai_format_github_comments "$ISSUE_COMMENTS_JSON" 10000 "$REPO")"
        fi

        # Cap very long issue bodies so the prompt stays usable.
        ISSUE_BODY_BYTES="$(printf '%s' "$ISSUE_BODY" | wc -c | tr -d ' ')"
        if [[ "$ISSUE_BODY_BYTES" -gt 20000 ]]; then
            ISSUE_BODY="$(printf '%s' "$ISSUE_BODY" | head -c 20000)
... [issue description truncated] ..."
        fi

        echo "  #$issue_number — $ISSUE_TITLE ($ISSUE_STATE)"

        cat >> "$ISSUES_FILE" <<EOF
------------------------------------------------------------
ISSUE #${issue_number}
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
# Fetch PR diff
# ============================================================

echo
echo "Fetching pull request diff..."

if ! gh pr diff "$PR_NUMBER" --repo "$REPO" > "$DIFF_FILE"; then
    echo "WARNING: Could not fetch PR diff via gh; continuing with empty diff."
    : > "$DIFF_FILE"
fi

DIFF_BYTES="$(wc -c < "$DIFF_FILE" | tr -d ' ')"
echo "Diff bytes: $DIFF_BYTES"

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

echo
echo "Fetching origin..."
git -C "$PROJECT_DIR" fetch --prune origin

echo
echo "Checking out source branch: $SOURCE_BRANCH"
if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$SOURCE_BRANCH"; then
    git -C "$PROJECT_DIR" checkout -B "$SOURCE_BRANCH" "origin/$SOURCE_BRANCH"
elif git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH"; then
    git -C "$PROJECT_DIR" checkout "$SOURCE_BRANCH"
    git -C "$PROJECT_DIR" pull --ff-only origin "$SOURCE_BRANCH" || true
else
    echo "ERROR: Source branch not found locally or on origin: $SOURCE_BRANCH"
    exit 13
fi

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
ai_prompt_set REPO "$REPO"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set PR_NUMBER "$PR_NUMBER"
ai_prompt_set PR_URL "$PR_URL"
ai_prompt_set AUTHOR "$AUTHOR"
ai_prompt_set SOURCE_BRANCH "$SOURCE_BRANCH"
ai_prompt_set TARGET_BRANCH "$TARGET_BRANCH"
ai_prompt_set PR_TITLE "$PR_TITLE"
ai_prompt_set PR_BODY "$PR_BODY"
ai_prompt_set PR_COMMENTS_TEXT "$PR_COMMENTS_TEXT"
ai_prompt_set SINCE_LAST_AI_COMMENTS_TEXT "$PR_SINCE_AI_COMMENTS_TEXT"
ai_prompt_set LINKED_ISSUES "$(cat "$ISSUES_FILE")"
ai_prompt_set DIFF "$(cat "$DIFF_FILE")"
ai_prompt_set REVIEW_FILE "$REVIEW_FILE"

ai_prompt_render "github-pr-review.txt" "$PROMPT_FILE"

# ============================================================
# Run Cursor
# ============================================================

ai_log_agent_start "STARTING AI AGENT (PR REVIEW)"
echo "Branch:        $SOURCE_BRANCH"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Review file:   $REVIEW_FILE"
echo "Linked issues: $LINKED_ISSUE_COUNT"
echo "PR discussion: $PR_COMMENTS_COUNT"
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
# Post PR comment
# ============================================================

COMMENT_FILE="$(mktemp)"
{
    cat "$REVIEW_FILE"
    cat <<EOF

---
_Label \`ai-review\` was processed automatically. Re-add \`ai-review\` to request another review._
EOF
} > "$COMMENT_FILE"

echo
echo "Posting review comment to pull request #$PR_NUMBER..."

COMMENT_URL="$(
    gh pr comment "$PR_NUMBER" \
        --repo "$REPO" \
        --body-file "$COMMENT_FILE"
)"

rm -f "$COMMENT_FILE"

if [[ -z "$COMMENT_URL" ]]; then
    echo
    echo "ERROR: Could not verify PR comment creation."
    exit 40
fi

echo "Comment posted: $COMMENT_URL"

# ============================================================
# Finalize PR review labels
# ============================================================

echo
echo "Updating labels: ai-reviewing -> ai-reviewed"

if gh pr edit "$PR_NUMBER" \
    --repo "$REPO" \
    --add-label "ai-reviewed" \
    --remove-label "ai-reviewing"; then
    LABELS_FINALIZED=1
else
    echo "ERROR: Could not set ai-reviewed label."
    exit 41
fi

gh pr edit "$PR_NUMBER" \
    --repo "$REPO" \
    --remove-label "ai-review-failed" \
    >/dev/null 2>&1 || true

# ============================================================
# Save result
# ============================================================

cat > "$RESULT_FILE" <<EOF
forge=github
project=$PROJECT
repository=$REPO
pull_request=$PR_NUMBER
pull_request_url=$PR_URL
source_branch=$SOURCE_BRANCH
target_branch=$TARGET_BRANCH
comment_url=$COMMENT_URL
labels=ai-reviewed
linked_issues=$LINKED_ISSUE_COUNT
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
comments_items=$COMMENTS_ITEMS_FILE
comments_full=$COMMENTS_FULL_FILE
comments_since_ai=$COMMENTS_SINCE_AI_FILE
prompt_file=$PROMPT_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "PR REVIEW COMPLETE"
echo "Forge:         github"
echo "Project:       $PROJECT"
echo "Pull request:  #$PR_NUMBER"
echo "PR URL:        $PR_URL"
echo "Comment URL:   $COMMENT_URL"
echo "Linked issues: $LINKED_ISSUE_COUNT"
echo "Labels:        ai-reviewed"
echo "Main log:      $LOG_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
