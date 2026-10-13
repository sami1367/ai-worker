#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Immutable worker code (libs, prompts, sibling scripts) lives next to this script.
WORKER_CODE_DIR="$SCRIPT_DIR"
# Runtime data (conf, logs, state, .env). Override with AI_WORKER_BASE_DIR when needed.
BASE_DIR="${AI_WORKER_BASE_DIR:-$SCRIPT_DIR}"
export WORKER_CODE_DIR BASE_DIR

PROJECTS_FILE="$BASE_DIR/github-projects.conf"
GITLAB_PROJECTS_FILE="$BASE_DIR/gitlab-projects.conf"
LOG_DIR="$BASE_DIR/logs"
STATE_DIR="$BASE_DIR/state"

WORKER_LOG="$LOG_DIR/worker.log"
LOCK_FILE="$STATE_DIR/worker.lock"

CHECK_INTERVAL="${CHECK_INTERVAL:-60}"

# shellcheck source=lib/common.sh
source "$WORKER_CODE_DIR/lib/common.sh"
# shellcheck source=lib/gitlab.sh
source "$WORKER_CODE_DIR/lib/gitlab.sh"

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
echo "Concurrency:          one task per repository; other repositories run in parallel"
echo "============================================================"

# ============================================================
# Per-repository agents
#
# Different repositories run at the same time. A repository runs
# at most one task at a time. A new `ai` issue is not started when
# that repository already has:
#   - an agent running, or
#   - an open issue labeled ai-working, or
#   - any open pull request / merge request (unless the project
#     sets "block_on_open_pr": false)
# Updating or reviewing an existing PR/MR is still allowed when
# that repository's agent is idle.
# ============================================================

declare -A REPO_AGENT_PIDS=()
declare -A REPO_AGENT_NAMES=()
declare -A REPO_BUSY_LOGGED=()

repo_slot_key() {
    local project_dir="$1"
    local canon

    canon="$(readlink -f "$project_dir" 2>/dev/null || printf '%s' "$project_dir")"
    printf '%s' "$canon" | tr -c 'A-Za-z0-9._-' '_'
}

reset_repo_busy_log() {
    local key

    for key in "${!REPO_BUSY_LOGGED[@]}"; do
        unset 'REPO_BUSY_LOGGED[$key]'
    done
}

# Return 0 when this checkout already has a running agent.
repo_agent_running() {
    local project_dir="$1"
    local project_name="$2"
    local key pid lock

    key="$(repo_slot_key "$project_dir")"
    pid="${REPO_AGENT_PIDS[$key]:-}"

    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        if [[ -z "${REPO_BUSY_LOGGED[$key]:-}" ]]; then
            REPO_BUSY_LOGGED[$key]=1
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] ${project_name} already has an agent running; not starting another task in this repository."
        fi
        return 0
    fi

    if [[ -n "$pid" ]]; then
        wait "$pid" 2>/dev/null || true
        unset 'REPO_AGENT_PIDS[$key]'
        unset 'REPO_AGENT_NAMES[$key]'
    fi

    lock="$STATE_DIR/slots/${key}.lock"
    if [[ -e "$lock" ]] && ! (
        flock -n 8 || exit 1
        exit 0
    ) 8>"$lock"; then
        if [[ -z "${REPO_BUSY_LOGGED[$key]:-}" ]]; then
            REPO_BUSY_LOGGED[$key]=1
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] ${project_name} already has an agent running; not starting another task in this repository."
        fi
        return 0
    fi

    return 1
}

reap_repo_agents() {
    local key pid name

    for key in "${!REPO_AGENT_PIDS[@]}"; do
        pid="${REPO_AGENT_PIDS[$key]}"
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null || true
            name="${REPO_AGENT_NAMES[$key]:-$key}"
            unset 'REPO_AGENT_PIDS[$key]'
            unset 'REPO_AGENT_NAMES[$key]'
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Agent finished for ${name}."
        fi
    done
}

# Run one task while holding this repository's lock.
# Usage: launch_repo_job <project_dir> <project_name> <function> [args...]
launch_repo_job() {
    local project_dir="$1"
    local project_name="$2"
    local key pid
    shift 2

    if repo_agent_running "$project_dir" "$project_name"; then
        return 1
    fi

    key="$(repo_slot_key "$project_dir")"
    mkdir -p "$STATE_DIR/slots"

    (
        exec 8>"$STATE_DIR/slots/${key}.lock"
        # Do not keep the supervisor lock. A restarted worker must be able
        # to start while this agent is still running; this repo lock is what
        # stops a second task in the same checkout.
        exec 9>&- || true
        if ! flock -n 8; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Not starting a second task in ${project_name} (repository lock is held)."
            exit 0
        fi
        "$@"
    ) &
    pid=$!
    REPO_AGENT_PIDS[$key]="$pid"
    REPO_AGENT_NAMES[$key]="$project_name"
    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Started agent for ${project_name} (pid ${pid})."
    return 0
}

# Wake when any agent exits, or after CHECK_INTERVAL, whichever comes first.
wait_for_running_agents() {
    local sleeper

    sleep "$CHECK_INTERVAL" &
    sleeper=$!

    wait -n || true

    if kill -0 "$sleeper" 2>/dev/null; then
        kill "$sleeper" 2>/dev/null || true
        wait "$sleeper" 2>/dev/null || true
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] An agent finished; checking repositories again."
    else
        wait "$sleeper" 2>/dev/null || true
    fi
}

github_repo_from_dir() {
    local project_dir="$1"

    if [[ -z "$project_dir" || ! -d "$project_dir" ]]; then
        return 0
    fi

    (
        cd "$project_dir"
        gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true
    )
}

# Resolve GitHub repo from conf entry full_name, else local checkout.
github_repo_from_entry() {
    local entry="${1:-}"
    local project_dir="${2:-}"
    local repo

    repo="$(jq -r '.full_name // .repo // empty' <<<"$entry" 2>/dev/null || true)"
    if [[ -n "$repo" ]]; then
        printf '%s\n' "$repo"
        return 0
    fi
    github_repo_from_dir "$project_dir"
}

# Resolve GitLab project path from conf entry, else local origin remote.
gitlab_repo_from_entry() {
    local entry="${1:-}"
    local project_dir="${2:-}"
    local path remote_url

    path="$(jq -r '.full_name // .repo // empty' <<<"$entry" 2>/dev/null || true)"
    if [[ -n "$path" ]]; then
        printf '%s\n' "$path"
        return 0
    fi

    remote_url="$(jq -r '.remote_url // empty' <<<"$entry" 2>/dev/null || true)"
    if [[ -n "$remote_url" ]]; then
        gitlab_path_from_remote "$remote_url" 2>/dev/null || true
        return 0
    fi

    gitlab_resolve_project_path "$project_dir" 2>/dev/null || true
}

# Ensure workspace for a conf entry. Returns 0 ready, 2 pending (skip cycle), 1 failed.
# Usage: ensure_entry_workspace <project> <project_dir> <forge> <entry_json>
ensure_entry_workspace() {
    local project="$1"
    local project_dir="$2"
    local forge="$3"
    local entry="${4:-}"
    local full_name rc=0

    full_name="$(jq -r '.full_name // .repo // empty' <<<"$entry" 2>/dev/null || true)"
    ai_ensure_project_workspace "$project_dir" "$project" "$forge" "$full_name" || rc=$?
    return "$rc"
}

github_find_open_issue_with_label() {
    local repo="$1"
    local label="$2"

    gh issue list \
        --repo "$repo" \
        --label "$label" \
        --state open \
        --limit 1 \
        --json number \
        --jq '.[0].number // empty' \
        2>/dev/null || true
}

github_find_open_pr() {
    local repo="$1"

    gh pr list \
        --repo "$repo" \
        --state open \
        --limit 1 \
        --json number,headRefName \
        --jq '.[0] | if . then "#\(.number) (\(.headRefName))" else empty end' \
        2>/dev/null || true
}

# Print a reason if this GitHub project already has in-flight issue work.
# When block_on_open_pr is 0, open PRs are ignored (ai-working still blocks).
github_in_flight_issue_reason() {
    local project="$1"
    local project_dir="$2"
    local block_on_open_pr="${3:-1}"
    local repo="${4:-}"
    local number pr_desc

    if [[ -z "$repo" ]]; then
        repo="$(github_repo_from_dir "$project_dir")"
    fi
    if [[ -z "$repo" ]]; then
        return 0
    fi

    number="$(github_find_open_issue_with_label "$repo" "ai-working")"
    if [[ -n "$number" ]]; then
        printf 'github %s: open issue #%s is labeled ai-working' "$project" "$number"
        return 0
    fi

    if [[ "$block_on_open_pr" == "0" ]]; then
        return 0
    fi

    pr_desc="$(github_find_open_pr "$repo")"
    if [[ -n "$pr_desc" ]]; then
        printf 'github %s: open pull request %s' "$project" "$pr_desc"
        return 0
    fi
}

# Print a reason if this GitLab project already has in-flight issue work.
# When block_on_open_pr is 0, open MRs are ignored (ai-working still blocks).
gitlab_in_flight_issue_reason() {
    local project="$1"
    local project_dir="$2"
    local block_on_open_pr="${3:-1}"
    local repo_path="${4:-}"
    local number mr_desc

    if ! gitlab_configured; then
        return 0
    fi

    if [[ -z "$repo_path" ]]; then
        repo_path="$(gitlab_resolve_project_path "$project_dir" 2>/dev/null || true)"
    fi
    if [[ -z "$repo_path" ]]; then
        return 0
    fi

    number="$(gitlab_find_open_issue_with_label "$repo_path" "ai-working" 2>/dev/null || true)"
    if [[ -n "$number" ]]; then
        printf 'gitlab %s: open issue #%s is labeled ai-working' "$project" "$number"
        return 0
    fi

    if [[ "$block_on_open_pr" == "0" ]]; then
        return 0
    fi

    mr_desc="$(gitlab_find_open_mr "$repo_path" 2>/dev/null || true)"
    if [[ -n "$mr_desc" ]]; then
        printf 'gitlab %s: open merge request %s' "$project" "$mr_desc"
        return 0
    fi
}

# ============================================================
# Background jobs (one repository at a time; lock held by caller)
# ============================================================

github_issue_job() {
    local PROJECT="$1"
    local REPO="$2"
    local ISSUE_NUMBER="$3"

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
        return 0
    fi

    gh issue edit "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --remove-label "ai-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$WORKER_CODE_DIR/run-issue.sh" "$PROJECT" "$ISSUE_NUMBER"
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
}

gitlab_issue_job() {
    local PROJECT="$1"
    local REPO_PATH="$2"
    local ISSUE_NUMBER="$3"

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
        return 0
    fi

    gitlab_edit_issue_labels "$REPO_PATH" "$ISSUE_NUMBER" \
        --remove "ai-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$WORKER_CODE_DIR/run-gitlab-issue.sh" "$PROJECT" "$ISSUE_NUMBER"
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
}

github_pr_implement_job() {
    local PROJECT="$1"
    local REPO="$2"
    local PR_NUMBER="$3"

    ai_log_banner "FOUND AI PR (IMPLEMENT)"
    echo "Forge:         github"
    echo "Project:       $PROJECT"
    echo "Repository:    $REPO"
    echo "Pull request:  #$PR_NUMBER"
    echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    echo
    echo "Changing labels: ai -> ai-working"

    if ! gh pr edit "$PR_NUMBER" \
        --repo "$REPO" \
        --add-label "ai-working" \
        --remove-label "ai"; then

        echo
        echo "ERROR: Could not mark PR as ai-working. Skipping it."
        return 0
    fi

    gh pr edit "$PR_NUMBER" \
        --repo "$REPO" \
        --remove-label "ai-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$WORKER_CODE_DIR/run-github-pr-implement.sh" "$PROJECT" "$PR_NUMBER"
    EXIT_CODE=$?
    set -e

    if [[ "$EXIT_CODE" -eq 0 ]]; then

        ai_log_banner "AI PR IMPLEMENT COMPLETED"
        echo "Forge:         github"
        echo "Project:       $PROJECT"
        echo "Pull request:  #$PR_NUMBER"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-pr" \
            --remove-label "ai-working" \
            >/dev/null 2>&1 || true

        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --remove-label "ai-failed" \
            >/dev/null 2>&1 || true

    else

        ai_log_banner "AI PR IMPLEMENT FAILED"
        echo "Forge:         github"
        echo "Project:       $PROJECT"
        echo "Pull request:  #$PR_NUMBER"
        echo "Exit code:     $EXIT_CODE"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-failed" \
            --remove-label "ai-working" \
            >/dev/null 2>&1 || true

        echo
        echo "The pull request was NOT automatically retried."
        echo "Review the logs first. When ready, add label: ai"
    fi
}

github_pr_review_job() {
    local PROJECT="$1"
    local REPO="$2"
    local PR_NUMBER="$3"

    ai_log_banner "FOUND AI PR REVIEW"
    echo "Forge:         github"
    echo "Project:       $PROJECT"
    echo "Repository:    $REPO"
    echo "Pull request:  #$PR_NUMBER"
    echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    echo
    echo "Changing labels: ai-review -> ai-reviewing"

    if ! gh pr edit "$PR_NUMBER" \
        --repo "$REPO" \
        --add-label "ai-reviewing" \
        --remove-label "ai-review"; then

        echo
        echo "ERROR: Could not mark PR as ai-reviewing. Skipping it."
        return 0
    fi

    gh pr edit "$PR_NUMBER" \
        --repo "$REPO" \
        --remove-label "ai-review-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$WORKER_CODE_DIR/run-github-pr-review.sh" "$PROJECT" "$PR_NUMBER"
    EXIT_CODE=$?
    set -e

    if [[ "$EXIT_CODE" -eq 0 ]]; then

        ai_log_banner "AI PR REVIEW COMPLETED"
        echo "Forge:         github"
        echo "Project:       $PROJECT"
        echo "Pull request:  #$PR_NUMBER"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-reviewed" \
            --remove-label "ai-reviewing" \
            >/dev/null 2>&1 || true

        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --remove-label "ai-review-failed" \
            >/dev/null 2>&1 || true

    else

        ai_log_banner "AI PR REVIEW FAILED"
        echo "Forge:         github"
        echo "Project:       $PROJECT"
        echo "Pull request:  #$PR_NUMBER"
        echo "Exit code:     $EXIT_CODE"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gh pr edit "$PR_NUMBER" \
            --repo "$REPO" \
            --add-label "ai-review-failed" \
            --remove-label "ai-reviewing" \
            >/dev/null 2>&1 || true

        echo
        echo "The pull request was NOT automatically re-reviewed."
        echo "Review the logs first. When ready, add label: ai-review"
    fi
}

gitlab_mr_implement_job() {
    local PROJECT="$1"
    local REPO_PATH="$2"
    local MR_IID="$3"

    ai_log_banner "FOUND AI MR (IMPLEMENT)"
    echo "Forge:          gitlab"
    echo "Project:        $PROJECT"
    echo "Repository:     $REPO_PATH"
    echo "Merge request:  !$MR_IID"
    echo "Time:           $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    echo
    echo "Changing labels: ai -> ai-working"

    if ! gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
        --add "ai-working" \
        --remove "ai"; then

        echo
        echo "ERROR: Could not mark MR as ai-working. Skipping it."
        return 0
    fi

    gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
        --remove "ai-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$WORKER_CODE_DIR/run-gitlab-mr-implement.sh" "$PROJECT" "$MR_IID"
    EXIT_CODE=$?
    set -e

    if [[ "$EXIT_CODE" -eq 0 ]]; then

        ai_log_banner "AI MR IMPLEMENT COMPLETED"
        echo "Forge:         gitlab"
        echo "Project:       $PROJECT"
        echo "Merge request: !$MR_IID"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --add "ai-pr" \
            --remove "ai-working" \
            >/dev/null 2>&1 || true

        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --remove "ai-failed" \
            >/dev/null 2>&1 || true

    else

        ai_log_banner "AI MR IMPLEMENT FAILED"
        echo "Forge:         gitlab"
        echo "Project:       $PROJECT"
        echo "Merge request: !$MR_IID"
        echo "Exit code:     $EXIT_CODE"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --add "ai-failed" \
            --remove "ai-working" \
            >/dev/null 2>&1 || true

        echo
        echo "The merge request was NOT automatically retried."
        echo "Review the logs first. When ready, add label: ai"
    fi
}

gitlab_mr_review_job() {
    local PROJECT="$1"
    local REPO_PATH="$2"
    local MR_IID="$3"

    ai_log_banner "FOUND AI MR REVIEW"
    echo "Forge:          gitlab"
    echo "Project:        $PROJECT"
    echo "Repository:     $REPO_PATH"
    echo "Merge request:  !$MR_IID"
    echo "Time:           $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"

    echo
    echo "Changing labels: ai-review -> ai-reviewing"

    if ! gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
        --add "ai-reviewing" \
        --remove "ai-review"; then

        echo
        echo "ERROR: Could not mark MR as ai-reviewing. Skipping it."
        return 0
    fi

    gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
        --remove "ai-review-failed" \
        >/dev/null 2>&1 || true

    set +e
    "$WORKER_CODE_DIR/run-gitlab-mr-review.sh" "$PROJECT" "$MR_IID"
    EXIT_CODE=$?
    set -e

    if [[ "$EXIT_CODE" -eq 0 ]]; then

        ai_log_banner "AI MR REVIEW COMPLETED"
        echo "Forge:         gitlab"
        echo "Project:       $PROJECT"
        echo "Merge request: !$MR_IID"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --add "ai-reviewed" \
            --remove "ai-reviewing" \
            >/dev/null 2>&1 || true

        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --remove "ai-review-failed" \
            >/dev/null 2>&1 || true

    else

        ai_log_banner "AI MR REVIEW FAILED"
        echo "Forge:         gitlab"
        echo "Project:       $PROJECT"
        echo "Merge request: !$MR_IID"
        echo "Exit code:     $EXIT_CODE"
        echo "Time:          $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "============================================================"

        gitlab_edit_mr_labels "$REPO_PATH" "$MR_IID" \
            --add "ai-review-failed" \
            --remove "ai-reviewing" \
            >/dev/null 2>&1 || true

        echo
        echo "The merge request was NOT automatically re-reviewed."
        echo "Review the logs first. When ready, add label: ai-review"
    fi
}

# ============================================================
# Process one GitHub issue (returns 0; work runs in the background)
# ============================================================

process_github_project() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local BLOCK_ON_OPEN_PR="${3:-1}"
    local ENTRY="${4:-}"
    local REPO ISSUE_NUMBER in_flight

    if repo_agent_running "$PROJECT_DIR" "$PROJECT"; then
        return 0
    fi

    REPO="$(github_repo_from_entry "$ENTRY" "$PROJECT_DIR")"

    if [[ -z "$REPO" ]]; then
        echo "WARNING: Cannot determine GitHub repository for: $PROJECT"
        return 0
    fi

    ISSUE_NUMBER="$(github_find_ai_issue "$REPO")"

    if [[ -z "$ISSUE_NUMBER" ]]; then
        return 0
    fi

    in_flight="$(github_in_flight_issue_reason "$PROJECT" "$PROJECT_DIR" "$BLOCK_ON_OPEN_PR" "$REPO")"
    if [[ -n "$in_flight" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Not starting a new issue in this repo ($in_flight)."
        return 0
    fi

    if ! ensure_entry_workspace "$PROJECT" "$PROJECT_DIR" "github" "$ENTRY"; then
        # 2 = clone pending (fair skip); other = hard failure. Retry next cycle either way.
        echo "WARNING: Skipping $PROJECT — workspace not ready for issue #$ISSUE_NUMBER"
        return 0
    fi

    launch_repo_job "$PROJECT_DIR" "$PROJECT" github_issue_job "$PROJECT" "$REPO" "$ISSUE_NUMBER"
    return 0
}

# ============================================================
# Process one GitLab issue
# ============================================================

process_gitlab_project() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local BLOCK_ON_OPEN_PR="${3:-1}"
    local ENTRY="${4:-}"
    local REPO_PATH ISSUE_NUMBER in_flight

    if repo_agent_running "$PROJECT_DIR" "$PROJECT"; then
        return 0
    fi

    if ! gitlab_configured; then
        if [[ "$GITLAB_WARNED" -eq 0 ]]; then
            echo "WARNING: GITLAB_TOKEN not set; skipping GitLab projects."
            GITLAB_WARNED=1
        fi
        return 0
    fi

    REPO_PATH="$(gitlab_repo_from_entry "$ENTRY" "$PROJECT_DIR")"

    if [[ -z "$REPO_PATH" ]]; then
        echo "WARNING: Cannot determine GitLab project for: $PROJECT"
        return 0
    fi

    ISSUE_NUMBER="$(gitlab_find_ai_issue "$REPO_PATH" 2>/dev/null || true)"

    if [[ -z "$ISSUE_NUMBER" ]]; then
        return 0
    fi

    in_flight="$(gitlab_in_flight_issue_reason "$PROJECT" "$PROJECT_DIR" "$BLOCK_ON_OPEN_PR" "$REPO_PATH")"
    if [[ -n "$in_flight" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Not starting a new issue in this repo ($in_flight)."
        return 0
    fi

    if ! ensure_entry_workspace "$PROJECT" "$PROJECT_DIR" "gitlab" "$ENTRY"; then
        echo "WARNING: Skipping $PROJECT — workspace not ready for issue #$ISSUE_NUMBER"
        return 0
    fi

    launch_repo_job "$PROJECT_DIR" "$PROJECT" gitlab_issue_job "$PROJECT" "$REPO_PATH" "$ISSUE_NUMBER"
    return 0
}

# ============================================================
# Process one GitHub pull request (implement on branch via ai label)
# ============================================================

process_github_pr_implement() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local _BLOCK="${3:-}"
    local ENTRY="${4:-}"
    local REPO PR_NUMBER

    if repo_agent_running "$PROJECT_DIR" "$PROJECT"; then
        return 0
    fi

    REPO="$(github_repo_from_entry "$ENTRY" "$PROJECT_DIR")"

    if [[ -z "$REPO" ]]; then
        echo "WARNING: Cannot determine GitHub repository for: $PROJECT"
        return 0
    fi

    PR_NUMBER="$(
        gh pr list \
            --repo "$REPO" \
            --label "ai" \
            --state open \
            --limit 100 \
            --json number,createdAt \
            --jq 'sort_by(.createdAt) | .[0].number // empty' \
            2>/dev/null || true
    )"

    if [[ -z "$PR_NUMBER" ]]; then
        return 0
    fi

    if ! ensure_entry_workspace "$PROJECT" "$PROJECT_DIR" "github" "$ENTRY"; then
        echo "WARNING: Skipping $PROJECT — workspace not ready for PR #$PR_NUMBER"
        return 0
    fi

    launch_repo_job "$PROJECT_DIR" "$PROJECT" github_pr_implement_job "$PROJECT" "$REPO" "$PR_NUMBER"
    return 0
}

# ============================================================
# Process one GitHub pull-request review
# ============================================================

process_github_pr_review() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local _BLOCK="${3:-}"
    local ENTRY="${4:-}"
    local REPO PR_NUMBER

    if repo_agent_running "$PROJECT_DIR" "$PROJECT"; then
        return 0
    fi

    REPO="$(github_repo_from_entry "$ENTRY" "$PROJECT_DIR")"

    if [[ -z "$REPO" ]]; then
        echo "WARNING: Cannot determine GitHub repository for: $PROJECT"
        return 0
    fi

    PR_NUMBER="$(
        gh pr list \
            --repo "$REPO" \
            --label "ai-review" \
            --state open \
            --limit 100 \
            --json number,createdAt \
            --jq 'sort_by(.createdAt) | .[0].number // empty' \
            2>/dev/null || true
    )"

    if [[ -z "$PR_NUMBER" ]]; then
        return 0
    fi

    if ! ensure_entry_workspace "$PROJECT" "$PROJECT_DIR" "github" "$ENTRY"; then
        echo "WARNING: Skipping $PROJECT — workspace not ready for PR review #$PR_NUMBER"
        return 0
    fi

    launch_repo_job "$PROJECT_DIR" "$PROJECT" github_pr_review_job "$PROJECT" "$REPO" "$PR_NUMBER"
    return 0
}

# ============================================================
# Process one GitLab merge request (implement on branch via ai label)
# ============================================================

process_gitlab_mr_implement() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local _BLOCK="${3:-}"
    local ENTRY="${4:-}"
    local REPO_PATH MR_IID

    if repo_agent_running "$PROJECT_DIR" "$PROJECT"; then
        return 0
    fi

    if ! gitlab_configured; then
        if [[ "$GITLAB_WARNED" -eq 0 ]]; then
            echo "WARNING: GITLAB_TOKEN not set; skipping GitLab projects."
            GITLAB_WARNED=1
        fi
        return 0
    fi

    REPO_PATH="$(gitlab_repo_from_entry "$ENTRY" "$PROJECT_DIR")"

    if [[ -z "$REPO_PATH" ]]; then
        echo "WARNING: Cannot determine GitLab project for: $PROJECT"
        return 0
    fi

    MR_IID="$(gitlab_find_ai_mr "$REPO_PATH" 2>/dev/null || true)"

    if [[ -z "$MR_IID" ]]; then
        return 0
    fi

    if ! ensure_entry_workspace "$PROJECT" "$PROJECT_DIR" "gitlab" "$ENTRY"; then
        echo "WARNING: Skipping $PROJECT — workspace not ready for MR !$MR_IID"
        return 0
    fi

    launch_repo_job "$PROJECT_DIR" "$PROJECT" gitlab_mr_implement_job "$PROJECT" "$REPO_PATH" "$MR_IID"
    return 0
}

# ============================================================
# Process one GitLab merge-request review
# ============================================================

process_gitlab_mr_review() {
    local PROJECT="$1"
    local PROJECT_DIR="$2"
    local _BLOCK="${3:-}"
    local ENTRY="${4:-}"
    local REPO_PATH MR_IID

    if repo_agent_running "$PROJECT_DIR" "$PROJECT"; then
        return 0
    fi

    if ! gitlab_configured; then
        if [[ "$GITLAB_WARNED" -eq 0 ]]; then
            echo "WARNING: GITLAB_TOKEN not set; skipping GitLab projects."
            GITLAB_WARNED=1
        fi
        return 0
    fi

    REPO_PATH="$(gitlab_repo_from_entry "$ENTRY" "$PROJECT_DIR")"

    if [[ -z "$REPO_PATH" ]]; then
        echo "WARNING: Cannot determine GitLab project for: $PROJECT"
        return 0
    fi

    MR_IID="$(gitlab_find_ai_review_mr "$REPO_PATH" 2>/dev/null || true)"

    if [[ -z "$MR_IID" ]]; then
        return 0
    fi

    if ! ensure_entry_workspace "$PROJECT" "$PROJECT_DIR" "gitlab" "$ENTRY"; then
        echo "WARNING: Skipping $PROJECT — workspace not ready for MR review !$MR_IID"
        return 0
    fi

    launch_repo_job "$PROJECT_DIR" "$PROJECT" gitlab_mr_review_job "$PROJECT" "$REPO_PATH" "$MR_IID"
    return 0
}

# ============================================================
# Main loop
#
# For each managed project, query the forge API by full_name for
# open ai / ai-review work (no local clone required). Only when
# work exists do we ensure the workspace and launch a job.
# ============================================================

while true; do

    reset_repo_busy_log
    reap_repo_agents

    # Priority inside one repository: issues, then PR/MR implement,
    # then reviews. A launch marks that repository busy, so later
    # handlers in this cycle skip it. Other repositories still start.
    if [[ -f "$PROJECTS_FILE" ]]; then
        ai_foreach_project "$PROJECTS_FILE" process_github_project || true
        ai_foreach_project "$PROJECTS_FILE" process_github_pr_implement || true
        ai_foreach_project "$PROJECTS_FILE" process_github_pr_review || true
    fi

    if [[ -f "$GITLAB_PROJECTS_FILE" ]]; then
        ai_foreach_project "$GITLAB_PROJECTS_FILE" process_gitlab_project || true
        ai_foreach_project "$GITLAB_PROJECTS_FILE" process_gitlab_mr_implement || true
        ai_foreach_project "$GITLAB_PROJECTS_FILE" process_gitlab_mr_review || true
    fi

    if [[ "${#REPO_AGENT_PIDS[@]}" -eq 0 ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] No queued AI issues or PR/MR reviews. Sleeping ${CHECK_INTERVAL}s."
        sleep "$CHECK_INTERVAL"
        continue
    fi

    if [[ "${#REPO_AGENT_PIDS[@]}" -eq 1 ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] 1 repository agent running. Checking again in ${CHECK_INTERVAL}s, or sooner when it finishes."
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] ${#REPO_AGENT_PIDS[@]} repository agents running. Checking again in ${CHECK_INTERVAL}s, or sooner when one finishes."
    fi
    wait_for_running_agents

done
