#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/projects.conf"
LOG_DIR="$BASE_DIR/logs"
STATE_DIR="$BASE_DIR/state"

WORKER_LOG="$LOG_DIR/worker.log"
LOCK_FILE="$STATE_DIR/worker.lock"

CHECK_INTERVAL=60

mkdir -p "$LOG_DIR" "$STATE_DIR"

# ============================================================
# Validate configuration
# ============================================================

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: Projects file not found:"
    echo "$PROJECTS_FILE"
    exit 1
fi

for cmd in git gh flock tee; do

    if ! command -v "$cmd" >/dev/null 2>&1; then

        echo "ERROR: Required command not found:"
        echo "$cmd"

        exit 1
    fi

done

# ============================================================
# Worker logging
# ============================================================

exec > >(tee -a "$WORKER_LOG") 2>&1

# ============================================================
# Prevent two worker processes
# ============================================================

exec 9>"$LOCK_FILE"

if ! flock -n 9; then

    echo
    echo "Another ai-worker process is already running."

    exit 0
fi

echo
echo "============================================================"
echo "                    AI WORKER STARTED"
echo "============================================================"
echo "Started:        $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Check interval: ${CHECK_INTERVAL}s"
echo "Projects file:  $PROJECTS_FILE"
echo "Worker log:     $WORKER_LOG"
echo "============================================================"

# ============================================================
# Main loop
# ============================================================

while true; do

    FOUND_TASK=0

    while IFS='=' read -r PROJECT PROJECT_DIR ||
          [[ -n "${PROJECT:-}" ]]; do

        # Remove possible Windows CR character.
        PROJECT="${PROJECT%$'\r'}"
        PROJECT_DIR="${PROJECT_DIR%$'\r'}"

        # Skip empty lines.
        [[ -z "$PROJECT" ]] && continue

        # Skip comments.
        [[ "$PROJECT" =~ ^[[:space:]]*# ]] && continue

        if [[ -z "$PROJECT_DIR" ]]; then

            echo "WARNING: Empty project path for:"
            echo "$PROJECT"

            continue
        fi

        if [[ ! -d "$PROJECT_DIR" ]]; then

            echo "WARNING: Project directory does not exist:"
            echo "$PROJECT_DIR"

            continue
        fi

        if ! git -C "$PROJECT_DIR" rev-parse \
            --is-inside-work-tree >/dev/null 2>&1; then

            echo "WARNING: Not a Git repository:"
            echo "$PROJECT_DIR"

            continue
        fi

        # ====================================================
        # Determine GitHub repository
        # ====================================================

        REPO="$(
            cd "$PROJECT_DIR"

            gh repo view \
                --json nameWithOwner \
                --jq '.nameWithOwner' \
                2>/dev/null || true
        )"

        if [[ -z "$REPO" ]]; then

            echo "WARNING:"
            echo "Cannot determine GitHub repository for:"
            echo "$PROJECT"

            continue
        fi

        # ====================================================
        # Find queued issue
        # ====================================================

        ISSUE_NUMBER="$(
            gh issue list \
                --repo "$REPO" \
                --label "ai" \
                --state open \
                --limit 1 \
                --json number \
                --jq '.[0].number // empty' \
                2>/dev/null || true
        )"

        if [[ -z "$ISSUE_NUMBER" ]]; then
            continue
        fi

        FOUND_TASK=1

        echo
        echo "============================================================"
        echo "                    FOUND AI ISSUE"
        echo "============================================================"
        echo "Project:    $PROJECT"
        echo "Repository: $REPO"
        echo "Issue:      #$ISSUE_NUMBER"
        echo "Time:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        # ====================================================
        # ai -> ai-working
        # ====================================================

        echo
        echo "Changing labels:"
        echo "ai -> ai-working"

        if ! gh issue edit "$ISSUE_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-working" \
            --remove-label "ai"; then

            echo
            echo "ERROR:"
            echo "Could not mark issue as ai-working."
            echo "Skipping it."

            break
        fi

        # If this issue is being manually retried,
        # remove the previous failed label.
        gh issue edit "$ISSUE_NUMBER" \
            --repo "$REPO" \
            --remove-label "ai-failed" \
            >/dev/null 2>&1 || true

        # ====================================================
        # Run Cursor task
        # ====================================================

        if "$BASE_DIR/run-issue.sh" \
            "$PROJECT" \
            "$ISSUE_NUMBER"; then

            echo
            echo "============================================================"
            echo "                   AI ISSUE COMPLETED"
            echo "============================================================"
            echo "Project: $PROJECT"
            echo "Issue:   #$ISSUE_NUMBER"
            echo "Time:    $(date '+%Y-%m-%d %H:%M:%S %Z')"
            echo "============================================================"

            # ================================================
            # ai-working -> ai-pr
            # ================================================

            gh issue edit "$ISSUE_NUMBER" \
                --repo "$REPO" \
                --add-label "ai-pr" \
                --remove-label "ai-working" \
                >/dev/null 2>&1 || true

            gh issue edit "$ISSUE_NUMBER" \
                --repo "$REPO" \
                --remove-label "ai-failed" \
                >/dev/null 2>&1 || true

        else

            EXIT_CODE=$?

            echo
            echo "============================================================"
            echo "                    AI ISSUE FAILED"
            echo "============================================================"
            echo "Project:   $PROJECT"
            echo "Issue:     #$ISSUE_NUMBER"
            echo "Exit code: $EXIT_CODE"
            echo "Time:      $(date '+%Y-%m-%d %H:%M:%S %Z')"
            echo "============================================================"

            # ================================================
            # ai-working -> ai-failed
            #
            # IMPORTANT:
            # We do NOT automatically add "ai" again.
            # This prevents an infinite retry loop.
            # ================================================

            gh issue edit "$ISSUE_NUMBER" \
                --repo "$REPO" \
                --add-label "ai-failed" \
                --remove-label "ai-working" \
                >/dev/null 2>&1 || true

            echo
            echo "The issue was NOT automatically retried."
            echo
            echo "Review the logs first."
            echo "When ready to retry, manually add label:"
            echo "ai"

        fi

        # Only one issue per polling cycle.
        break

    done < "$PROJECTS_FILE"

    if [[ "$FOUND_TASK" -eq 0 ]]; then

        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] No queued AI issues."

    fi

    sleep "$CHECK_INTERVAL"

done
