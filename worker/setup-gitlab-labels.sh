#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Immutable worker code (libs, prompts, sibling scripts) lives next to this script.
WORKER_CODE_DIR="$SCRIPT_DIR"
# Runtime data (conf, logs, state, .env). Override with AI_WORKER_BASE_DIR when needed.
BASE_DIR="${AI_WORKER_BASE_DIR:-$SCRIPT_DIR}"
export WORKER_CODE_DIR BASE_DIR

PROJECTS_FILE="$BASE_DIR/gitlab-projects.conf"

# shellcheck source=lib/common.sh
source "$WORKER_CODE_DIR/lib/common.sh"
# shellcheck source=lib/gitlab.sh
source "$WORKER_CODE_DIR/lib/gitlab.sh"

ai_load_env "$BASE_DIR/.env"

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: GitLab projects file not found:"
    echo "$PROJECTS_FILE"
    exit 1
fi

ai_require_cmds curl jq git || exit 1

if ! gitlab_configured; then
    echo "ERROR: GITLAB_TOKEN is not set."
    echo
    echo "Create $BASE_DIR/.env from .env.example and set GITLAB_TOKEN."
    exit 1
fi

setup_one() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local REPO_PATH

    REPO_PATH="$(gitlab_resolve_project_path "$PROJECT_DIR")" || true

    if [[ -z "$REPO_PATH" ]]; then
        echo
        echo "Skipping (cannot resolve GitLab path): $PROJECT"
        return 0
    fi

    ai_log_banner "Configuring GitLab labels"
    echo "Project:    $PROJECT"
    echo "Repository: $REPO_PATH"
    echo "Host:       $GITLAB_HOST"
    echo "============================================================"

    gitlab_create_label "$REPO_PATH" "ai" "0E8A16" \
        "Queue this issue for the AI worker"

    gitlab_create_label "$REPO_PATH" "ai-working" "FBCA04" \
        "AI worker is currently processing this issue"

    gitlab_create_label "$REPO_PATH" "ai-pr" "1D76DB" \
        "AI worker completed the issue and created a merge request"

    gitlab_create_label "$REPO_PATH" "ai-failed" "D73A4A" \
        "AI worker failed; review logs before retrying"

    gitlab_create_label "$REPO_PATH" "ai-review" "7057FF" \
        "Queue this merge request for an AI code review"

    gitlab_create_label "$REPO_PATH" "ai-reviewing" "FBCA04" \
        "AI worker is currently reviewing this merge request"

    gitlab_create_label "$REPO_PATH" "ai-reviewed" "0E8A16" \
        "AI worker posted a review comment on this merge request"

    gitlab_create_label "$REPO_PATH" "ai-review-failed" "D73A4A" \
        "AI MR review failed; check logs before retrying"

    return 0
}

ai_foreach_project "$PROJECTS_FILE" setup_one

ai_log_banner "GitLab labels are ready."
