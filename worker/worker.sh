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
# Written by the web API when a forge webhook delivers an AI label event.
WAKE_POLL_FILE="$STATE_DIR/wake-poll"

CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
# How many repositories to poll (forge API label checks) at once per pass.
POLL_CONCURRENCY="${POLL_CONCURRENCY:-5}"
# Max concurrent issue/PR agents (each agent runs exactly one task).
# Still at most one task per repository. Default 1 = global single-task mode.
WORKERS="${WORKERS:-1}"
if ! [[ "$WORKERS" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: WORKERS must be a positive integer (got: ${WORKERS})"
    exit 1
fi
if ! [[ "$POLL_CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: POLL_CONCURRENCY must be a positive integer (got: ${POLL_CONCURRENCY})"
    exit 1
fi

# shellcheck source=lib/common.sh
source "$WORKER_CODE_DIR/lib/common.sh"
# shellcheck source=lib/gitlab.sh
source "$WORKER_CODE_DIR/lib/gitlab.sh"

mkdir -p "$LOG_DIR" "$STATE_DIR"
ai_load_env "$BASE_DIR/.env"
ai_load_platform_credentials "$BASE_DIR"

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
echo "Poll concurrency:     ${POLL_CONCURRENCY} repos at a time"
echo "GitHub projects:      $PROJECTS_FILE"
echo "GitLab projects:      $GITLAB_PROJECTS_FILE"
echo "GitLab host:          ${GITLAB_HOST}"
echo "GitLab token set:     $(gitlab_configured && echo yes || echo no)"
echo "Worker log:           $WORKER_LOG"
echo "Workers (concurrency): ${WORKERS} (one task each; at most one task per repository)"
echo "============================================================"

# ============================================================
# Concurrent agents
#
# Up to WORKERS agents run at once. Each agent handles exactly one
# issue/PR/MR. A repository still runs at most one task at a time.
# A new `ai` issue is not started when that repository already has:
#   - an agent running, or
#   - an open issue labeled ai-working, or
#   - an open PR/MR labeled ai / ai-working / ai-failed / ai-pr
#     (unless the project sets "block_on_open_pr": false)
# Human open PRs/MRs without those labels do not block.
# Updating or reviewing an existing PR/MR is still allowed when
# that repository's agent is idle.
# ============================================================

declare -A REPO_AGENT_PIDS=()
declare -A REPO_AGENT_NAMES=()
declare -A REPO_AGENT_META=()
declare -A REPO_BUSY_LOGGED=()
WORKERS_LIMIT_LOGGED=0
ACTIVE_AGENTS_FILE="$STATE_DIR/active-agents.json"

repo_slot_key() {
    local project_dir="$1"
    local canon

    canon="$(readlink -f "$project_dir" 2>/dev/null || printf '%s' "$project_dir")"
    printf '%s' "$canon" | tr -c 'A-Za-z0-9._-' '_'
}

# Read branch= from a task state file matching project + external id (if any).
active_task_branch_from_state() {
    local project_name="$1"
    local external_id="$2"
    local f branch=""

    [[ -n "$project_name" && -n "$external_id" ]] || return 0
    shopt -s nullglob
    for f in "$STATE_DIR/${project_name}"-*-"${external_id}".running; do
        branch="$(awk -F= '/^branch=/{print substr($0, index($0,$2)); exit}' "$f" 2>/dev/null || true)"
        if [[ -n "$branch" ]]; then
            printf '%s' "$branch"
            shopt -u nullglob
            return 0
        fi
    done
    shopt -u nullglob
    return 0
}

# Persist currently running agents for the platform heartbeat / Tasks UI.
write_active_agents_file() {
    local key pid meta tmp branch name external_id
    local items='[]'

    mkdir -p "$STATE_DIR"
    for key in "${!REPO_AGENT_PIDS[@]}"; do
        pid="${REPO_AGENT_PIDS[$key]}"
        [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || continue
        meta="${REPO_AGENT_META[$key]:-}"
        name="${REPO_AGENT_NAMES[$key]:-$key}"
        if [[ -z "$meta" ]]; then
            meta="$(jq -nc \
                --arg name "$name" \
                --argjson pid "$pid" \
                '{repositoryName:$name,pid:$pid}')"
        else
            meta="$(jq -c --argjson pid "$pid" '. + {pid:$pid}' <<<"$meta" 2>/dev/null || printf '%s' "$meta")"
        fi
        # Prefer live branch from the run state file (set after checkout / create).
        external_id="$(jq -r '.externalId // empty' <<<"$meta" 2>/dev/null || true)"
        branch="$(active_task_branch_from_state "$name" "$external_id")"
        if [[ -z "$branch" ]]; then
            branch="$(jq -r '.branch // empty' <<<"$meta" 2>/dev/null || true)"
        fi
        if [[ -n "$branch" ]]; then
            meta="$(jq -c --arg branch "$branch" '. + {branch:$branch}' <<<"$meta" 2>/dev/null || printf '%s' "$meta")"
            REPO_AGENT_META[$key]="$(jq -c 'del(.pid)' <<<"$meta" 2>/dev/null || printf '%s' "${REPO_AGENT_META[$key]}")"
        fi
        items="$(jq -c --argjson item "$meta" '. + [$item]' <<<"$items" 2>/dev/null || printf '%s' "$items")"
    done

    tmp="${ACTIVE_AGENTS_FILE}.${$}.tmp"
    printf '%s\n' "$items" >"$tmp"
    mv -f "$tmp" "$ACTIVE_AGENTS_FILE"
}

agent_meta_from_job() {
    local project_name="$1"
    local job_fn="$2"
    local external_id="${3:-}"
    local task_type=""
    local branch=""

    case "$job_fn" in
        github_issue_job) task_type="github_issue" ;;
        gitlab_issue_job) task_type="gitlab_issue" ;;
        github_pr_implement_job) task_type="github_pr_implement" ;;
        gitlab_mr_implement_job) task_type="gitlab_mr_implement" ;;
        github_pr_review_job) task_type="github_pr_review" ;;
        gitlab_mr_review_job) task_type="gitlab_mr_review" ;;
        *) task_type="$job_fn" ;;
    esac

    # Provisional issue branch until the run writes the real name to its state file.
    if [[ -n "$external_id" && ( "$task_type" == "github_issue" || "$task_type" == "gitlab_issue" ) ]]; then
        branch="ai/issue-${external_id}"
    fi

    jq -nc \
        --arg name "$project_name" \
        --arg taskType "$task_type" \
        --arg externalId "$external_id" \
        --arg branch "$branch" \
        --arg startedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        --arg correlationId "$(date +%s)-${project_name}-${task_type}-${external_id}-$$" \
        '{
            repositoryName: $name,
            taskType: $taskType,
            externalId: $externalId,
            startedAt: $startedAt,
            correlationId: $correlationId
        } + (if $branch != "" then {branch: $branch} else {} end)'
}

report_task_run_from_meta() {
    local meta="$1"
    local status="$2"
    local exit_code="${3:-}"
    local payload

    [[ -n "$meta" ]] || return 0

    payload="$(jq -nc \
        --argjson meta "$meta" \
        --arg status "$status" \
        --arg exitCode "$exit_code" \
        --arg finishedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        '
        ($meta.taskType // "") as $tt
        | {
            repositoryName: ($meta.repositoryName // null),
            forgeType: (if ($tt | startswith("gitlab_")) then "gitlab" else "github" end),
            taskType: $tt,
            externalId: ($meta.externalId // ""),
            status: $status,
            startedAt: ($meta.startedAt // null),
            correlationId: ($meta.correlationId // null),
            resultMetadata: (if ($meta.branch // "") != "" then {branch: $meta.branch} else {} end)
          }
        + (if $status == "running" or $status == "starting" then {} else {finishedAt: $finishedAt} end)
        + (if $exitCode == "" then {} else {exitCode: ($exitCode | tonumber)} end)
        + (if ($meta.title // "") != "" then {title: $meta.title} else {} end)
        ' 2>/dev/null || true)"

    if [[ -n "$payload" ]]; then
        ai_report_task_run "$payload"
    fi
}

reset_repo_busy_log() {
    local key

    for key in "${!REPO_BUSY_LOGGED[@]}"; do
        unset 'REPO_BUSY_LOGGED[$key]'
    done
    WORKERS_LIMIT_LOGGED=0
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
        unset 'REPO_AGENT_META[$key]'
        write_active_agents_file
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
    local key pid name meta exit_code changed=0

    for key in "${!REPO_AGENT_PIDS[@]}"; do
        pid="${REPO_AGENT_PIDS[$key]}"
        if ! kill -0 "$pid" 2>/dev/null; then
            exit_code=0
            wait "$pid" 2>/dev/null || exit_code=$?
            name="${REPO_AGENT_NAMES[$key]:-$key}"
            meta="${REPO_AGENT_META[$key]:-}"
            if [[ "$exit_code" -eq 0 ]]; then
                report_task_run_from_meta "$meta" "succeeded" "0"
            else
                report_task_run_from_meta "$meta" "failed" "$exit_code"
            fi
            unset 'REPO_AGENT_PIDS[$key]'
            unset 'REPO_AGENT_NAMES[$key]'
            unset 'REPO_AGENT_META[$key]'
            changed=1
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Agent finished for ${name} (exit ${exit_code})."
        fi
    done
    if [[ "$changed" -eq 1 ]]; then
        write_active_agents_file
    fi
}

workers_at_capacity() {
    reap_repo_agents
    [[ "${#REPO_AGENT_PIDS[@]}" -ge "$WORKERS" ]]
}

# Run one task while holding this repository's lock.
# Usage: launch_repo_job <project_dir> <project_name> <function> [args...]
launch_repo_job() {
    local project_dir="$1"
    local project_name="$2"
    local job_fn="$3"
    local key pid external_id=""
    shift 2

    if workers_at_capacity; then
        if [[ "$WORKERS_LIMIT_LOGGED" -eq 0 ]]; then
            WORKERS_LIMIT_LOGGED=1
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] At WORKERS=${WORKERS} limit; deferring further tasks until a slot frees."
        fi
        return 1
    fi

    if repo_agent_running "$project_dir" "$project_name"; then
        return 1
    fi

    key="$(repo_slot_key "$project_dir")"
    mkdir -p "$STATE_DIR/slots"

    # Job args: <fn> <project> <repo> <external_id>
    external_id="${4:-}"

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
    REPO_AGENT_META[$key]="$(agent_meta_from_job "$project_name" "$job_fn" "$external_id")"
    write_active_agents_file
    report_task_run_from_meta "${REPO_AGENT_META[$key]}" "running"
    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Started agent for ${project_name} (pid ${pid})."
    return 0
}

# When POLL_LAUNCH_QUEUE is set (parallel poll), enqueue a launch for the parent
# shell. Otherwise launch immediately (sequential poll / tests).
# Usage: same as launch_repo_job
queue_or_launch_repo_job() {
    local project_dir="$1"
    local project_name="$2"
    local job_fn="$3"
    local line

    if [[ -z "${POLL_LAUNCH_QUEUE:-}" ]]; then
        launch_repo_job "$@"
        return $?
    fi

    # Encode as JSON so paths/names with spaces stay intact.
    line="$(jq -nc \
        --arg project_dir "$project_dir" \
        --arg project_name "$project_name" \
        --arg job_fn "$job_fn" \
        --arg arg1 "${4:-}" \
        --arg arg2 "${5:-}" \
        --arg arg3 "${6:-}" \
        '{
            project_dir: $project_dir,
            project_name: $project_name,
            job_fn: $job_fn,
            args: [$arg1, $arg2, $arg3]
        }')" || return 1

    (
        flock 8
        printf '%s\n' "$line" >>"$POLL_LAUNCH_QUEUE"
    ) 8>"${POLL_LAUNCH_QUEUE}.lock"
    return 0
}

drain_poll_launch_queue() {
    local queue_file="$1"
    local line project_dir project_name job_fn a1 a2 a3

    [[ -f "$queue_file" ]] || return 0

    while IFS= read -r line || [[ -n "${line:-}" ]]; do
        [[ -z "$line" ]] && continue
        project_dir="$(jq -r '.project_dir // empty' <<<"$line")"
        project_name="$(jq -r '.project_name // empty' <<<"$line")"
        job_fn="$(jq -r '.job_fn // empty' <<<"$line")"
        a1="$(jq -r '.args[0] // empty' <<<"$line")"
        a2="$(jq -r '.args[1] // empty' <<<"$line")"
        a3="$(jq -r '.args[2] // empty' <<<"$line")"
        if [[ -z "$project_dir" || -z "$project_name" || -z "$job_fn" ]]; then
            continue
        fi
        # Parent shell owns REPO_AGENT_* maps; re-check capacity/busy here.
        launch_repo_job "$project_dir" "$project_name" "$job_fn" "$a1" "$a2" "$a3" || true
    done <"$queue_file"
}

# Run one poll pass over all projects with up to POLL_CONCURRENCY parallel
# forge checks; drain queued launches in the parent afterward.
poll_projects_parallel() {
    local projects_file="$1"
    local callback="$2"
    local queue_file

    if [[ ! -f "$projects_file" ]]; then
        return 0
    fi

    mkdir -p "$STATE_DIR"
    queue_file="$(mktemp "$STATE_DIR/poll-launch.XXXXXX")"
    POLL_LAUNCH_QUEUE="$queue_file"
    ai_foreach_project_parallel "$projects_file" "$callback" "$POLL_CONCURRENCY" || true
    POLL_LAUNCH_QUEUE=""
    drain_poll_launch_queue "$queue_file"
    rm -f "$queue_file" "${queue_file}.lock"
}

consume_wake_poll() {
    if [[ -f "$WAKE_POLL_FILE" ]]; then
        rm -f "$WAKE_POLL_FILE" 2>/dev/null || true
        return 0
    fi
    return 1
}

# Sleep up to CHECK_INTERVAL, waking early if a forge webhook touched wake-poll
# or (when wait_agents=1) if any background agent exits.
interruptible_sleep() {
    local wait_agents="${1:-0}"
    local remaining="$CHECK_INTERVAL"
    local chunk

    while (( remaining > 0 )); do
        if consume_wake_poll; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Webhook wake received; checking repositories again."
            return 0
        fi

        chunk=5
        if (( chunk > remaining )); then
            chunk=$remaining
        fi

        if [[ "$wait_agents" -eq 1 && "${#REPO_AGENT_PIDS[@]}" -gt 0 ]]; then
            sleep "$chunk" &
            local sleeper=$!
            wait -n || true
            if kill -0 "$sleeper" 2>/dev/null; then
                # An agent finished (or another child exited) before sleep ended.
                kill "$sleeper" 2>/dev/null || true
                wait "$sleeper" 2>/dev/null || true
                if consume_wake_poll; then
                    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Webhook wake received; checking repositories again."
                else
                    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] An agent finished; checking repositories again."
                fi
                return 0
            fi
            wait "$sleeper" 2>/dev/null || true
        else
            sleep "$chunk"
        fi

        remaining=$((remaining - chunk))
    done
}

# Wake when any agent exits, after CHECK_INTERVAL, or on webhook wake file.
wait_for_running_agents() {
    interruptible_sleep 1
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

# AI implement-workflow labels on an open PR that should block starting a new
# `ai` issue (human PRs without these labels do not block).
GITHUB_AI_IN_FLIGHT_PR_LABELS=(ai ai-working ai-failed ai-pr)

# Print a short description of the oldest open PR carrying an AI implement
# label, or empty. Example: "#12 (ai/issue-3, ai-pr)"
github_find_open_pr() {
    local repo="$1"
    local label row created desc best_created="" best_desc=""

    for label in "${GITHUB_AI_IN_FLIGHT_PR_LABELS[@]}"; do
        row="$(
            gh pr list \
                --repo "$repo" \
                --state open \
                --label "$label" \
                --limit 1 \
                --json number,headRefName,createdAt \
                --jq \
                ".[0] | if . then \"\(.createdAt)\t#\(.number) (\(.headRefName // \\\"unknown\\\"), ${label})\" else empty end" \
                2>/dev/null || true
        )"
        [[ -n "$row" ]] || continue

        created="${row%%$'\t'*}"
        desc="${row#*$'\t'}"
        [[ -n "$created" && -n "$desc" ]] || continue

        if [[ -z "$best_created" || "$created" < "$best_created" ]]; then
            best_created="$created"
            best_desc="$desc"
        fi
    done

    printf '%s' "$best_desc"
}

# Print a reason if this GitHub project already has in-flight issue work.
# When block_on_open_pr is 0, AI-labeled open PRs are ignored (ai-working still blocks).
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
        printf 'github %s: open AI-labeled pull request %s' "$project" "$pr_desc"
        return 0
    fi
}

# Print a reason if this GitLab project already has in-flight issue work.
# When block_on_open_pr is 0, AI-labeled open MRs are ignored (ai-working still blocks).
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
        printf 'gitlab %s: open AI-labeled merge request %s' "$project" "$mr_desc"
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

    if ! ai_try_claim_repo_lock "github" "$REPO" "github_issue" "$ISSUE_NUMBER"; then
        return 0
    fi

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

    if ! ai_try_claim_repo_lock "gitlab" "$REPO_PATH" "gitlab_issue" "$ISSUE_NUMBER"; then
        return 0
    fi

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

    if ! ai_try_claim_repo_lock "github" "$REPO" "github_pr_implement" "$PR_NUMBER"; then
        return 0
    fi

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

    if ! ai_try_claim_repo_lock "github" "$REPO" "github_pr_review" "$PR_NUMBER"; then
        return 0
    fi

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

    if ! ai_try_claim_repo_lock "gitlab" "$REPO_PATH" "gitlab_mr_implement" "$MR_IID"; then
        return 0
    fi

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

    if ! ai_try_claim_repo_lock "gitlab" "$REPO_PATH" "gitlab_mr_review" "$MR_IID"; then
        return 0
    fi

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

    queue_or_launch_repo_job "$PROJECT_DIR" "$PROJECT" github_issue_job "$PROJECT" "$REPO" "$ISSUE_NUMBER"
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

    queue_or_launch_repo_job "$PROJECT_DIR" "$PROJECT" gitlab_issue_job "$PROJECT" "$REPO_PATH" "$ISSUE_NUMBER"
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

    queue_or_launch_repo_job "$PROJECT_DIR" "$PROJECT" github_pr_implement_job "$PROJECT" "$REPO" "$PR_NUMBER"
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

    queue_or_launch_repo_job "$PROJECT_DIR" "$PROJECT" github_pr_review_job "$PROJECT" "$REPO" "$PR_NUMBER"
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

    queue_or_launch_repo_job "$PROJECT_DIR" "$PROJECT" gitlab_mr_implement_job "$PROJECT" "$REPO_PATH" "$MR_IID"
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

    queue_or_launch_repo_job "$PROJECT_DIR" "$PROJECT" gitlab_mr_review_job "$PROJECT" "$REPO_PATH" "$MR_IID"
    return 0
}

# ============================================================
# Main loop
#
# For each managed project, query the forge API by full_name for
# open ai / ai-review work (no local clone required). Only when
# work exists do we ensure the workspace and launch a job.
# Forge checks run up to POLL_CONCURRENCY repos in parallel; agent
# launches stay in the parent shell (shared REPO_AGENT_* state).
# ============================================================

while true; do

    # Pick up forge/provider tokens and UI runtime settings written after this
    # process started (connect GitHub/GitLab/Cursor, change AI agent, poll interval).
    ai_load_platform_credentials "$BASE_DIR"
    # Refresh interval each cycle so Settings → poll interval applies without reload.
    if [[ "${CHECK_INTERVAL:-}" =~ ^[0-9]+$ ]] && (( CHECK_INTERVAL >= 15 )); then
        :
    else
        CHECK_INTERVAL=30
    fi

    # Clear a pending wake so we don't immediately re-wake after this poll.
    consume_wake_poll || true

    reset_repo_busy_log
    reap_repo_agents

    # Priority inside one repository: issues, then PR/MR implement,
    # then reviews. A launch marks that repository busy, so later
    # handlers in this cycle skip it. Other repositories still start.
    if [[ -f "$PROJECTS_FILE" ]]; then
        poll_projects_parallel "$PROJECTS_FILE" process_github_project
        poll_projects_parallel "$PROJECTS_FILE" process_github_pr_implement
        poll_projects_parallel "$PROJECTS_FILE" process_github_pr_review
    fi

    if [[ -f "$GITLAB_PROJECTS_FILE" ]]; then
        poll_projects_parallel "$GITLAB_PROJECTS_FILE" process_gitlab_project
        poll_projects_parallel "$GITLAB_PROJECTS_FILE" process_gitlab_mr_implement
        poll_projects_parallel "$GITLAB_PROJECTS_FILE" process_gitlab_mr_review
    fi

    if [[ "${#REPO_AGENT_PIDS[@]}" -eq 0 ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] No queued AI issues or PR/MR reviews. Sleeping ${CHECK_INTERVAL}s (or until webhook)."
        interruptible_sleep 0
        continue
    fi

    if [[ "${#REPO_AGENT_PIDS[@]}" -eq 1 ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] 1 repository agent running. Checking again in ${CHECK_INTERVAL}s, or sooner when it finishes / webhook."
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] ${#REPO_AGENT_PIDS[@]} repository agents running. Checking again in ${CHECK_INTERVAL}s, or sooner when one finishes / webhook."
    fi
    wait_for_running_agents

done
