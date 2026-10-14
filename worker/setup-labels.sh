#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Immutable worker code (libs, prompts, sibling scripts) lives next to this script.
WORKER_CODE_DIR="$SCRIPT_DIR"
# Runtime data (conf, logs, state, .env). Override with AI_WORKER_BASE_DIR when needed.
BASE_DIR="${AI_WORKER_BASE_DIR:-$SCRIPT_DIR}"
export WORKER_CODE_DIR BASE_DIR

PROJECTS_FILE="$BASE_DIR/github-projects.conf"
GITLAB_SETUP="$WORKER_CODE_DIR/setup-gitlab-labels.sh"

# shellcheck source=lib/common.sh
source "$WORKER_CODE_DIR/lib/common.sh"
# shellcheck source=lib/labels.sh
source "$WORKER_CODE_DIR/lib/labels.sh"

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "NOTE: GitHub projects file not found:"
    echo "$PROJECTS_FILE"
    echo "Skipping GitHub label setup."
else

    if ! command -v gh >/dev/null 2>&1; then
        echo "ERROR: GitHub CLI (gh) is not installed."
        exit 1
    fi

    if ! gh auth status >/dev/null 2>&1; then
        echo "ERROR: GitHub CLI is not authenticated."
        echo
        echo "Run:"
        echo "gh auth login"
        exit 1
    fi

    setup_github_one() {
        local PROJECT="$1"
        local PROJECT_DIR="$2"
        local REPO

        REPO="$(
            cd "$PROJECT_DIR"
            gh repo view --json nameWithOwner --jq '.nameWithOwner'
        )"

        ai_log_banner "Configuring GitHub labels"
        echo "Project:    $PROJECT"
        echo "Repository: $REPO"
        echo "============================================================"

        ai_ensure_github_labels_local "$REPO"

        return 0
    }

    ai_foreach_project "$PROJECTS_FILE" setup_github_one

    ai_log_banner "GitHub labels are ready."
fi

# ============================================================
# GitLab labels
# ============================================================

if [[ -x "$GITLAB_SETUP" || -f "$GITLAB_SETUP" ]]; then
    echo
    echo "Setting up GitLab labels..."
    bash "$GITLAB_SETUP"
fi

echo
echo "============================================================"
echo "All labels are ready."
echo "============================================================"
