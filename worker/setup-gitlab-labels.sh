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
# shellcheck source=lib/labels.sh
source "$WORKER_CODE_DIR/lib/labels.sh"

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

    ai_ensure_gitlab_labels_local "$REPO_PATH"

    return 0
}

ai_foreach_project "$PROJECTS_FILE" setup_one

ai_log_banner "GitLab labels are ready."
