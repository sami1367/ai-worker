#!/usr/bin/env bash

set -Eeuo pipefail

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/projects.conf"

if [[ ! -f "$PROJECTS_FILE" ]]; then

    echo "ERROR: Projects file not found:"
    echo "$PROJECTS_FILE"

    exit 1
fi

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

while IFS='=' read -r PROJECT PROJECT_DIR ||
      [[ -n "${PROJECT:-}" ]]; do

    PROJECT="${PROJECT%$'\r'}"
    PROJECT_DIR="${PROJECT_DIR%$'\r'}"

    [[ -z "$PROJECT" ]] && continue

    [[ "$PROJECT" =~ ^[[:space:]]*# ]] && continue

    if [[ ! -d "$PROJECT_DIR" ]]; then

        echo
        echo "Skipping missing directory:"
        echo "$PROJECT_DIR"

        continue
    fi

    REPO="$(
        cd "$PROJECT_DIR"

        gh repo view \
            --json nameWithOwner \
            --jq '.nameWithOwner'
    )"

    echo
    echo "============================================================"
    echo "Configuring labels"
    echo "============================================================"
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

done < "$PROJECTS_FILE"

echo
echo "============================================================"
echo "All labels are ready."
echo "============================================================"
