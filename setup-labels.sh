#!/usr/bin/env bash

set -Eeuo pipefail

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/projects.conf"
GITLAB_SETUP="$BASE_DIR/setup-gitlab-labels.sh"

# shellcheck source=lib/common.sh
source "$BASE_DIR/lib/common.sh"

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

        gh label create "ai" \
            --repo "$REPO" \
            --color "0E8A16" \
            --description "Queue this issue for the AI worker" \
            --force

        gh label create "ai-working" \
            --repo "$REPO" \
            --color "FBCA04" \
            --description "AI worker is currently processing this issue" \
            --force

        gh label create "ai-pr" \
            --repo "$REPO" \
            --color "1D76DB" \
            --description "AI worker completed the issue and created a pull request" \
            --force

        gh label create "ai-failed" \
            --repo "$REPO" \
            --color "D73A4A" \
            --description "AI worker failed; review logs before retrying" \
            --force

        gh label create "ai-review" \
            --repo "$REPO" \
            --color "7057FF" \
            --description "Queue this open pull request for an AI review comment" \
            --force

        gh label create "ai-reviewing" \
            --repo "$REPO" \
            --color "FBCA04" \
            --description "AI worker is currently reviewing this pull request" \
            --force

        gh label create "ai-reviewed" \
            --repo "$REPO" \
            --color "0E8A16" \
            --description "AI review comment was posted on this pull request" \
            --force

        gh label create "ai-review-failed" \
            --repo "$REPO" \
            --color "D73A4A" \
            --description "AI PR review failed; review logs before retrying" \
            --force

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
