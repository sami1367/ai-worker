#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/projects.conf"
GITLAB_PROJECTS_FILE="$BASE_DIR/gitlab-projects.conf"
LOG_DIR="$BASE_DIR/logs"
STATE_DIR="$BASE_DIR/state"

WORKER_LOG="$LOG_DIR/worker.log"
LOCK_FILE="$STATE_DIR/worker.lock"

CHECK_INTERVAL=60

# shellcheck source=lib/common.sh
source "$BASE_DIR/lib/common.sh"
# shellcheck source=lib/gitlab.sh
source "$BASE_DIR/lib/gitlab.sh"

mkdir -p "$LOG_DIR" "$STATE_DIR"
ai_load_env "$BASE_DIR/.env"

# ============================================================
# Validate configuration
# ============================================================

if [[ ! -f "$PROJECTS_FILE" && ! -f "$GITLAB_PROJECTS_FILE" ]]; then
    echo "ERROR: No projects files found."
    echo "Expected $PROJECTS_FILE and/or $GITLAB_PROJECTS_FILE"
    exit 1
fi

ai_require_cmds git flock tee jq curl || exit 1

if [[ -f "$PROJECTS_FILE" ]] && ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI (gh) is required for GitHub projects."
    exit 1
fi

GITLAB_WARNED=0

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

ai_log_banner "AI WORKER STARTED"
echo "Started:              $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Check interval:       ${CHECK_INTERVAL}s"
echo "GitHub projects:      $PROJECTS_FILE"
echo "GitLab projects:      $GITLAB_PROJECTS_FILE"
echo "GitLab host:          ${GITLAB_HOST}"
echo "GitLab token set:     $(gitlab_configured && echo yes || echo no)"
echo "Worker log:           $WORKER_LOG"
echo "============================================================"

# ============================================================
# Process one GitHub issue (returns 0 if handled, 1 if none/skip)
# Sets FOUND_TASK=1 when a task was claimed.
# ============================================================

process_github_project() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local REPO ISSUE_NUMBER

    REPO="$(
        cd "$PROJECT_DIR"
        gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true
    )"

    if [[ -z "$REPO" ]]; then
        echo "WARNING: Cannot determine GitHub repository for: $PROJECT"
        return 0
    fi

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
        return 0
    fi

    FOUND_TASK=1

    ai_log_banner "FOUND AI ISSUE"
    echo "Forge:      github"
    echo "Project:    $PROJECT"
    echo "Repository: $REPO"
    echo "Issue:      #$ISSUE_NUMBER"
    echo "Time:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    echo
    echo "Changing labels: ai -> ai-working"

    if ! gh issue edit "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --add-label "ai-working" \
        --remove-label "ai"; then

        echo
        echo "ERROR: Could not mark issue as ai-working. Skipping it."
        return 1
    fi

    gh issue edit "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --remove-label "ai-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$BASE_DIR/run-issue.sh" "$PROJECT" "$ISSUE_NUMBER"
    EXIT_CODE=$?
    set -e

    if [[ "$EXIT_CODE" -eq 0 ]]; then

        ai_log_banner "AI ISSUE COMPLETED"
        echo "Forge:   github"
        echo "Project: $PROJECT"
        echo "Issue:   #$ISSUE_NUMBER"
        echo "Time:    $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

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

        ai_log_banner "AI ISSUE FAILED"
        echo "Forge:     github"
        echo "Project:   $PROJECT"
        echo "Issue:     #$ISSUE_NUMBER"
        echo "Exit code: $EXIT_CODE"
        echo "Time:      $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gh issue edit "$ISSUE_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-failed" \
            --remove-label "ai-working" \
            >/dev/null 2>&1 || true

        echo
        echo "The issue was NOT automatically retried."
        echo "Review the logs first. When ready, add label: ai"
    fi

    return 1
}

# ============================================================
# Process one GitLab issue
# ============================================================

process_gitlab_project() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local REPO_PATH ISSUE_NUMBER

    if ! gitlab_configured; then
        if [[ "$GITLAB_WARNED" -eq 0 ]]; then
            echo "WARNING: GITLAB_TOKEN not set; skipping GitLab projects."
            GITLAB_WARNED=1
        fi
        return 0
    fi

    REPO_PATH="$(gitlab_resolve_project_path "$PROJECT_DIR" 2>/dev/null || true)"

    if [[ -z "$REPO_PATH" ]]; then
        echo "WARNING: Cannot determine GitLab project for: $PROJECT"
        return 0
    fi

    ISSUE_NUMBER="$(gitlab_find_ai_issue "$REPO_PATH" 2>/dev/null || true)"

    if [[ -z "$ISSUE_NUMBER" ]]; then
        return 0
    fi

    FOUND_TASK=1

    ai_log_banner "FOUND AI ISSUE"
    echo "Forge:      gitlab"
    echo "Project:    $PROJECT"
    echo "Repository: $REPO_PATH"
    echo "Issue:      #$ISSUE_NUMBER"
    echo "Time:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    echo
    echo "Changing labels: ai -> ai-working"

    if ! gitlab_edit_issue_labels "$REPO_PATH" "$ISSUE_NUMBER" \
        --add "ai-working" \
        --remove "ai"; then

        echo
        echo "ERROR: Could not mark issue as ai-working. Skipping it."
        return 1
    fi

    gitlab_edit_issue_labels "$REPO_PATH" "$ISSUE_NUMBER" \
        --remove "ai-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$BASE_DIR/run-gitlab-issue.sh" "$PROJECT" "$ISSUE_NUMBER"
    EXIT_CODE=$?
    set -e

    if [[ "$EXIT_CODE" -eq 0 ]]; then

        ai_log_banner "AI ISSUE COMPLETED"
        echo "Forge:   gitlab"
        echo "Project: $PROJECT"
        echo "Issue:   #$ISSUE_NUMBER"
        echo "Time:    $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gitlab_edit_issue_labels "$REPO_PATH" "$ISSUE_NUMBER" \
            --add "ai-pr" \
            --remove "ai-working" \
            >/dev/null 2>&1 || true

        gitlab_edit_issue_labels "$REPO_PATH" "$ISSUE_NUMBER" \
            --remove "ai-failed" \
            >/dev/null 2>&1 || true

    else

        ai_log_banner "AI ISSUE FAILED"
        echo "Forge:     gitlab"
        echo "Project:   $PROJECT"
        echo "Issue:     #$ISSUE_NUMBER"
        echo "Exit code: $EXIT_CODE"
        echo "Time:      $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gitlab_edit_issue_labels "$REPO_PATH" "$ISSUE_NUMBER" \
            --add "ai-failed" \
            --remove "ai-working" \
            >/dev/null 2>&1 || true

        echo
        echo "The issue was NOT automatically retried."
        echo "Review the logs first. When ready, add label: ai"
    fi

    return 1
}

# ============================================================
# Main loop
# ============================================================

while true; do

    FOUND_TASK=0

    # GitHub first, then GitLab. Callbacks return 1 after handling
    # one issue so ai_foreach_project stops scanning.
    if [[ -f "$PROJECTS_FILE" ]]; then
        ai_foreach_project "$PROJECTS_FILE" process_github_project || true
    fi

    if [[ "$FOUND_TASK" -eq 0 && -f "$GITLAB_PROJECTS_FILE" ]]; then
        ai_foreach_project "$GITLAB_PROJECTS_FILE" process_gitlab_project || true
    fi

    if [[ "$FOUND_TASK" -eq 0 ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] No queued AI issues."
    fi

    sleep "$CHECK_INTERVAL"

done
