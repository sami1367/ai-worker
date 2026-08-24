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
# shellcheck source=lib/gitlab.sh
source "$BASE_DIR/lib/gitlab.sh"

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

LOG_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.log"
CURSOR_LOG="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.cursor.ndjson"
CURSOR_ERR_LOG="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.cursor.stderr.log"
PROMPT_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.prompt.txt"
RESULT_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.result.txt"
REVIEW_FILE="$PROJECT_DIR/.ai-mr-review.md"
DIFF_FILE="$LOG_DIR/${PROJECT}-gitlab-mr-${MR_IID}-${TIMESTAMP}.diff.txt"
STATE_FILE="$STATE_DIR/${PROJECT}-gitlab-mr-${MR_IID}.running"

exec > >(tee -a "$LOG_FILE") 2>&1

REPO_PATH=""
MR_TITLE=""
MR_URL=""
SOURCE_BRANCH=""
TARGET_BRANCH=""

# ============================================================
# Cleanup
# ============================================================

cleanup() {
    rc=$?

    trap - EXIT INT TERM
    set +e

    ai_log_banner "CLEANUP"
    echo "Exit code: $rc"

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
cursor_log=$CURSOR_LOG
EOF

ai_log_banner "CURSOR AI GITLAB MR REVIEW"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Forge:         gitlab"
echo "Host:          $GITLAB_HOST"
echo "Project:       $PROJECT"
echo "Merge request: !$MR_IID"
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

if [[ "$MR_STATE" != "opened" ]]; then
    echo
    echo "Merge request is not open."
    echo "Nothing to do."
    exit 0
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
# Build Cursor prompt
# ============================================================

rm -f "$REVIEW_FILE"

{
    cat <<EOF
You are an autonomous senior code reviewer reviewing a GitLab merge request.

Repository: $REPO_PATH
GitLab host: $GITLAB_HOST
Project directory: $PROJECT_DIR
Merge request: !$MR_IID
MR URL: $MR_URL
Author: $AUTHOR
Source branch: $SOURCE_BRANCH
Target branch: $TARGET_BRANCH

You are currently checked out on the merge request source branch.
Review the changes carefully. You may inspect any repository files for context.

============================================================
MR TITLE
============================================================

$MR_TITLE

============================================================
MR DESCRIPTION
============================================================

$MR_BODY

============================================================
MR DIFF (from GitLab API; may be truncated)
============================================================

EOF
    cat "$DIFF_FILE"
    cat <<EOF

============================================================
YOUR JOB
============================================================

Produce a thorough, actionable code review of this merge request.

You are running unattended.

Do not ask questions.
Do not ask for confirmation.
Do not wait for user approval.

You MAY:

- inspect and search repository files
- read tests, configs, and related code for context
- run read-only checks (tests, lint, type-check) if helpful

You MUST NOT:

- modify any source files (except the single review output file below)
- run git commands
- call the GitLab API
- create, switch, delete, or modify branches
- create commits
- push code
- create or merge merge requests
- change git remotes
- read, print, or modify .env files
- reveal passwords, tokens, API keys, SSH keys, or other secrets
- approve or merge the merge request

A separate automation script will post your review as a GitLab MR comment.

============================================================
REVIEW OUTPUT FILE (REQUIRED)
============================================================

Write your COMPLETE review as Markdown into exactly this file path:

$REVIEW_FILE

Overwrite the file if it already exists.
Do not write the review anywhere else.
Do not modify any other files.

============================================================
REVIEW CONTENT GUIDELINES
============================================================

Structure the Markdown review like this:

## Summary
Brief overall assessment (what the MR does and whether it looks ready).

## Strengths
What looks good.

## Issues
Ordered by severity (blocker / major / minor / nit).
For each issue include:
- file path and approximate location when possible
- what is wrong
- why it matters
- a concrete suggestion

## Testing
Gaps or risks in test coverage, and what you would verify before merge.

## Verdict
One of: Approve / Request changes / Needs discussion — with one short sentence why.

Be specific and technical. Prefer fewer high-signal findings over vague advice.
If the diff is truncated, say so and review what you can see plus the branch contents.

============================================================
FINAL RESPONSE
============================================================

After writing $REVIEW_FILE, reply with a one-line confirmation that the review file was written.
EOF
} > "$PROMPT_FILE"

# ============================================================
# Run Cursor
# ============================================================

ai_log_banner "STARTING CURSOR AGENT (MR REVIEW)"
echo "Branch:        $SOURCE_BRANCH"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Review file:   $REVIEW_FILE"
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
        cat <<EOF
## AI Code Review

_Automated review by the Cursor AI worker for merge request !${MR_IID}._

EOF
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
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
cursor_log=$CURSOR_LOG
cursor_stderr=$CURSOR_ERR_LOG
EOF

ai_log_banner "MR REVIEW COMPLETE"
echo "Forge:         gitlab"
echo "Project:       $PROJECT"
echo "Merge request: !$MR_IID"
echo "MR URL:        $MR_URL"
echo "Note id:       $NOTE_ID"
echo "Main log:      $LOG_FILE"
echo "Cursor log:    $CURSOR_LOG"
echo "Result file:   $RESULT_FILE"
echo "============================================================"
