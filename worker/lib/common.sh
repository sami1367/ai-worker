#!/usr/bin/env bash
# Shared helpers for the AI worker. Source from other scripts; do not execute.

# Resolve BASE_DIR from the sourcing script when not already set.
# Code directory (this lib's parent). Runtime data may differ via BASE_DIR / AI_WORKER_BASE_DIR.
: "${WORKER_CODE_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ -z "${BASE_DIR:-}" ]]; then
  if [[ -n "${AI_WORKER_BASE_DIR:-}" ]]; then
    BASE_DIR="$AI_WORKER_BASE_DIR"
  else
    BASE_DIR="$WORKER_CODE_DIR"
  fi
fi
AI_WORKER_LOG="${BASE_DIR}/logs/worker.log"

# Print to the current log stream and mirror to worker.log (visible via tail -f logs/worker.log).
ai_echo_worker() {
    printf '%s\n' "$1"
    printf '%s\n' "$1" >>"$AI_WORKER_LOG"
}

# One highly visible line — easy to spot when tailing worker.log.
ai_log_worker_star_line() {
    local stars
    stars="$(printf '%*s' 1000 '' | tr ' ' '*')"
    ai_echo_worker "$stars"
}

# After fetching discussion items: star marker + latest comment in the thread.
ai_log_latest_discussion_comment() {
    local items_json="$1"
    local context="${2:-discussion}"

    ai_log_worker_star_line
    ai_echo_worker "LATEST COMMENT after fetch ($context):"

    if [[ -z "$items_json" || "$items_json" == "[]" || "$items_json" == "null" ]]; then
        ai_echo_worker "(no comments fetched)"
        return 0
    fi

    while IFS= read -r line || [[ -n "$line" ]]; do
        ai_echo_worker "$line"
    done < <(
        jq -r '
            (length - 1) as $idx |
            .[$idx] |
            "[\($idx)] \(.created_at) author=\(.author) role=\(.role) ai_review=\(.is_ai_review)\n\(.body)"
        ' <<<"$items_json"
    )
}

ai_load_env() {
    local env_file="${1:-$BASE_DIR/.env}"

    if [[ -f "$env_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$env_file"
        set +a
    fi
}

# Load forge + AI provider credentials and UI runtime settings written by the
# web control plane. Safe to call repeatedly (e.g. each poll cycle) so tokens,
# default AI provider, and poll interval added after the worker started are
# picked up without a full container recreate.
ai_load_platform_credentials() {
    local base="${1:-${BASE_DIR:-.}}"
    local forge_file="$base/forge-credentials.env"
    local provider_file="$base/provider-credentials.env"
    local runtime_file="$base/worker-runtime.env"

    if [[ -f "$forge_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$forge_file"
        set +a
    fi

    if [[ -f "$provider_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$provider_file"
        set +a
    fi

    if [[ -f "$runtime_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$runtime_file"
        set +a
    fi

    # Keep git HTTPS helpers in sync when tokens appear mid-run.
    if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]] && command -v gh >/dev/null 2>&1; then
        gh auth setup-git >/dev/null 2>&1 || true
    fi
    if [[ -n "${GITLAB_TOKEN:-}" ]]; then
        local gitlab_host="${GITLAB_HOST:-gitlab.com}"
        gitlab_host="${gitlab_host#https://}"
        gitlab_host="${gitlab_host#http://}"
        gitlab_host="${gitlab_host%%/*}"
        git config --global "credential.https://${gitlab_host}.helper" \
            '!f() { echo "username=oauth2"; echo "password=${GITLAB_TOKEN}"; }; f' >/dev/null 2>&1 || true
    fi
}

ai_require_cmds() {
    local cmd
    for cmd in "$@"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo "ERROR: Required command not found: $cmd"
            return 1
        fi
    done
}

# Deprecated: use ai_init from lib/ai.sh instead.
ai_detect_cursor() {
    # shellcheck source=lib/ai/cursor.sh
    source "$WORKER_CODE_DIR/lib/ai/cursor.sh"
    ai_cursor_detect
}

# Emit one JSON object per registered project (NDJSON).
# Fields: name, path, block_on_open_pr (bool; default true), optional custom_prompt.
# File must be a JSON array of objects. Leading blank/# comment lines are allowed.
ai_list_project_entries() {
    local projects_file="$1"
    local json_body

    if [[ ! -f "$projects_file" ]]; then
        return 0
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo "ERROR: jq is required to parse projects file: $projects_file" >&2
        return 1
    fi

    json_body="$(
        awk '
            BEGIN { p = 0; err = 0 }
            {
                gsub(/\r$/, "")
                if (!p) {
                    line = $0
                    sub(/^[[:space:]]+/, "", line)
                    if (line == "" || line ~ /^#/) next
                    if (line ~ /^\[/) p = 1
                    else {
                        print "ERROR: projects file must be a JSON array (got: " line ")" > "/dev/stderr"
                        err = 1
                        exit 2
                    }
                }
                if (p) print
            }
            END {
                if (err) exit 2
                if (!p) {
                    print "ERROR: projects file has no JSON array" > "/dev/stderr"
                    exit 2
                }
            }
        ' "$projects_file"
    )" || return 1

    jq -c '
        if type != "array" then
            error("projects file must be a JSON array")
        else . end
        | .[]
        | select(type == "object")
        | {
            name: (.name // "" | tostring),
            path: ((.path // .dir // "") | tostring),
            block_on_open_pr: (
                (if has("block_on_open_pr") then .block_on_open_pr else true end)
                | if type == "boolean" then .
                  elif (tostring | ascii_downcase) == "false" then false
                  elif tostring == "0" then false
                  elif (tostring | ascii_downcase) == "no" then false
                  elif (tostring | ascii_downcase) == "off" then false
                  else true end
            ),
            full_name: (.full_name // .repo // "" | tostring),
            remote_url: (.remote_url // "" | tostring),
            forge: (.forge // "" | tostring),
            custom_prompt: (.custom_prompt // "" | tostring)
          }
        | with_entries(select(.value != ""))
        | select(.name != "" and .path != "")
    ' <<<"$json_body"
}

# Normalize a project option to 0/1. Missing/empty defaults to the given default (0 or 1).
# Usage: ai_project_option_bool <value> <default_0_or_1>
ai_project_option_bool() {
    local value="${1:-}"
    local default="${2:-1}"
    local norm

    if [[ -z "$value" || "$value" == "null" ]]; then
        printf '%s' "$default"
        return 0
    fi

    norm="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
    case "$norm" in
        1|true|yes|on) printf '1' ;;
        0|false|no|off) printf '0' ;;
        *) printf '%s' "$default" ;;
    esac
}

# Resolve one project entry JSON by name (exact match). Prints nothing and returns 1 if missing.
# Usage: ai_resolve_project_entry <projects_file> <project_name>
ai_resolve_project_entry() {
    local projects_file="$1"
    local project="$2"
    local entry name

    if [[ ! -f "$projects_file" ]]; then
        echo "ERROR: Projects file not found: $projects_file" >&2
        return 1
    fi

    while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
        [[ -z "$entry" ]] && continue
        if command -v jq >/dev/null 2>&1; then
            name="$(jq -r '.name // empty' <<<"$entry")"
        else
            name=""
        fi
        if [[ "$name" == "$project" ]]; then
            printf '%s\n' "$entry"
            return 0
        fi
    done < <(ai_list_project_entries "$projects_file")

    return 1
}

# Resolve a managed project entry by forge full_name (org/repo or group/project).
# Falls back to unique short-name match when full_name is missing from older conf.
# Usage: ai_resolve_project_entry_by_full_name <projects_file> <full_name>
ai_resolve_project_entry_by_full_name() {
    local projects_file="$1"
    local want="$2"
    local want_lc short entry full name remote matches match_count

    if [[ ! -f "$projects_file" || -z "$want" ]]; then
        return 1
    fi

    want_lc="$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')"
    short="${want##*/}"

    while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
        [[ -z "$entry" ]] && continue
        full="$(jq -r '.full_name // .repo // empty' <<<"$entry" | tr '[:upper:]' '[:lower:]')"
        remote="$(jq -r '.remote_url // empty' <<<"$entry" | tr '[:upper:]' '[:lower:]')"
        if [[ -n "$full" && "$full" == "$want_lc" ]]; then
            printf '%s\n' "$entry"
            return 0
        fi
        if [[ -n "$remote" ]] && {
            [[ "$remote" == *"/${want_lc}.git" ]] || [[ "$remote" == *"/${want_lc}" ]]
        }; then
            printf '%s\n' "$entry"
            return 0
        fi
    done < <(ai_list_project_entries "$projects_file")

    # Unique short-name fallback for conf exported before full_name existed
    matches=()
    while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
        [[ -z "$entry" ]] && continue
        name="$(jq -r '.name // empty' <<<"$entry")"
        if [[ "$name" == "$short" || "$name" == "$want" ]]; then
            matches+=("$entry")
        fi
    done < <(ai_list_project_entries "$projects_file")

    match_count="${#matches[@]}"
    if [[ "$match_count" -eq 1 ]]; then
        printf '%s\n' "${matches[0]}"
        return 0
    fi

    return 1
}

# Resolve project path from a conf/JSON file.
ai_resolve_project_dir() {
    local projects_file="$1"
    local project="$2"
    local entry

    entry="$(ai_resolve_project_entry "$projects_file" "$project")" || return 1
    jq -r '.path // empty' <<<"$entry"
}

# Read a boolean project option (prints 0 or 1). Default is 1 when unset.
# Usage: ai_project_entry_bool <entry_json> <key> [default_0_or_1]
ai_project_entry_bool() {
    local entry="$1"
    local key="$2"
    local default="${3:-1}"
    local value

    value="$(jq -r --arg key "$key" '.[$key] | if . == null then empty else tostring end' <<<"$entry" 2>/dev/null || true)"
    ai_project_option_bool "$value" "$default"
}

# Validate a project directory is a usable git repo.
# Usage: ai_validate_project_dir <project_name> <project_dir> [quiet]
# Pass quiet=1 to suppress warnings (lazy-clone polls expect missing dirs).
ai_validate_project_dir() {
    local project="$1"
    local project_dir="$2"
    local quiet="${3:-0}"

    if [[ -z "$project_dir" ]]; then
        [[ "$quiet" == "1" ]] || echo "WARNING: Empty project path for: $project"
        return 1
    fi

    if [[ ! -d "$project_dir" ]]; then
        [[ "$quiet" == "1" ]] || echo "WARNING: Project directory does not exist: $project_dir"
        return 1
    fi

    if ! git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        [[ "$quiet" == "1" ]] || echo "WARNING: Not a Git repository: $project_dir"
        return 1
    fi

    return 0
}

# Fetch and check out a PR/MR source branch for implement/review runners.
#
# Managed workspaces are cloned with --single-branch, so remote.origin.fetch only
# covers the default branch. In that mode `git push -u` does not create
# refs/remotes/origin/<branch>, and a plain `git fetch --prune origin` never
# learns about task branches — review then fails with exit 13 even though the
# branch exists on the forge (and the MR/PR was opened from it).
#
# Usage: ai_fetch_and_checkout_source_branch <project_dir> <source_branch>
# Returns 13 if the branch is not on origin and not present locally.
ai_fetch_and_checkout_source_branch() {
    local project_dir="$1"
    local source_branch="$2"

    if [[ -z "$project_dir" || -z "$source_branch" ]]; then
        echo "ERROR: ai_fetch_and_checkout_source_branch requires project_dir and source_branch"
        return 13
    fi

    echo
    echo "Fetching origin..."
    git -C "$project_dir" fetch --prune origin

    # Explicit refspec: required for --single-branch clones.
    echo "Fetching source branch from origin: $source_branch"
    if ! git -C "$project_dir" fetch origin \
        "+refs/heads/${source_branch}:refs/remotes/origin/${source_branch}"; then
        echo "WARNING: Could not fetch origin/${source_branch}; will try local refs only."
    fi

    echo
    echo "Checking out source branch: $source_branch"
    if git -C "$project_dir" show-ref --verify --quiet "refs/remotes/origin/$source_branch"; then
        git -C "$project_dir" checkout -B "$source_branch" "origin/$source_branch"
        return 0
    fi

    if git -C "$project_dir" show-ref --verify --quiet "refs/heads/$source_branch"; then
        git -C "$project_dir" checkout "$source_branch"
        git -C "$project_dir" pull --ff-only origin "$source_branch" || true
        return 0
    fi

    echo "ERROR: Source branch not found locally or on origin: $source_branch"
    return 13
}

# When /data/config/ssh/id_ed25519 exists, point origin at git@host:path and
# ensure GIT_SSH_COMMAND is set. Needed for forges that disable HTTP(S) git.
# Usage: ai_configure_ssh_git_remote <project_dir>
ai_configure_ssh_git_remote() {
    local project_dir="$1"
    local key_src="${BASE_DIR}/ssh/id_ed25519"
    local key_home="${HOME}/.ssh/id_ed25519"
    local origin host path ssh_url

    [[ -n "$project_dir" && -d "$project_dir/.git" ]] || return 0
    [[ -f "$key_src" ]] || return 0

    mkdir -p "${HOME}/.ssh"
    chmod 700 "${HOME}/.ssh" 2>/dev/null || true
    if [[ ! -f "$key_home" ]]; then
        cp "$key_src" "$key_home"
        chmod 600 "$key_home"
    fi
    if [[ -f "${BASE_DIR}/ssh/known_hosts" && ! -f "${HOME}/.ssh/known_hosts" ]]; then
        cp "${BASE_DIR}/ssh/known_hosts" "${HOME}/.ssh/known_hosts"
        chmod 644 "${HOME}/.ssh/known_hosts"
    fi

    export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i ${key_home} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"

    origin="$(git -C "$project_dir" remote get-url origin 2>/dev/null || true)"
    if [[ "$origin" =~ ^https://([^/]+)/(.+)$ ]]; then
        host="${BASH_REMATCH[1]}"
        path="${BASH_REMATCH[2]}"
        path="${path%.git}.git"
        ssh_url="git@${host}:${path}"
        git -C "$project_dir" remote set-url origin "$ssh_url"
        echo "Using SSH remote (HTTP git unavailable on forge): $ssh_url"
    fi
}

# Normalize an issue title for special-case matching (trim + lowercase).
ai_normalize_issue_title() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# Return 0 if the title is the "new release" / "new tag" shortcut.
ai_is_new_release_title() {
    local norm
    norm="$(ai_normalize_issue_title "$1")"
    [[ "$norm" == "new release" || "$norm" == "new tag" ]]
}

# Highest local git tag matching vMAJOR.MINOR.PATCH, or empty.
# Usage: ai_latest_git_semver_tag <project_dir>
ai_latest_git_semver_tag() {
    local project_dir="$1"

    git -C "$project_dir" tag -l 'v*.*.*' --sort=-v:refname | head -n 1
}

# Highest vMAJOR.MINOR.PATCH from stdin lines (non-matching lines ignored).
ai_max_semver_tag_from_lines() {
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true
}

# Print next patch bump for a vMAJOR.MINOR.PATCH tag.
# Usage: ai_bump_semver_patch <tag>
ai_bump_semver_patch() {
    local tag="$1"

    if [[ ! "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        return 1
    fi

    printf 'v%s.%s.%s\n' \
        "${BASH_REMATCH[1]}" \
        "${BASH_REMATCH[2]}" \
        "$((BASH_REMATCH[3] + 1))"
}

# True if a local git tag ref exists.
# Usage: ai_git_tag_exists <project_dir> <tag>
ai_git_tag_exists() {
    local project_dir="$1"
    local tag="$2"

    git -C "$project_dir" rev-parse -q --verify "refs/tags/${tag}" >/dev/null
}

# Iterate registered projects. Calls:
#   callback <project> <project_dir> <block_on_open_pr_0_or_1> <entry_json>
# Allows missing checkouts when full_name/remote_url is present (lazy clone).
# A non-zero callback return stops the scan.
ai_foreach_project() {
    local projects_file="$1"
    local callback="$2"
    local entry project project_dir block_on_open_pr full_name remote_url

    if [[ ! -f "$projects_file" ]]; then
        return 0
    fi

    while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
        [[ -z "$entry" ]] && continue

        project="$(jq -r '.name // empty' <<<"$entry")"
        project_dir="$(jq -r '.path // empty' <<<"$entry")"
        full_name="$(jq -r '.full_name // .repo // empty' <<<"$entry")"
        remote_url="$(jq -r '.remote_url // empty' <<<"$entry")"
        block_on_open_pr="$(ai_project_entry_bool "$entry" "block_on_open_pr" 1)"

        # Missing dirs are normal (lazy clone). Without forge identity, skip quietly.
        if ! ai_validate_project_dir "$project" "$project_dir" 1; then
            if [[ -z "$full_name" && -z "$remote_url" ]]; then
                continue
            fi
        fi

        if ! "$callback" "$project" "$project_dir" "$block_on_open_pr" "$entry"; then
            return 1
        fi
    done < <(ai_list_project_entries "$projects_file")

    return 0
}

# Reap finished PIDs from a name-referenced array (bash 4.3+ nameref).
# Usage: ai_reap_pid_array <array_varname>
ai_reap_pid_array() {
    local -n _ai_pids_ref="$1"
    local -a alive=()
    local p
    for p in "${_ai_pids_ref[@]}"; do
        if kill -0 "$p" 2>/dev/null; then
            alive+=("$p")
        else
            wait "$p" 2>/dev/null || true
        fi
    done
    _ai_pids_ref=("${alive[@]}")
}

# Like ai_foreach_project, but runs up to POLL_CONCURRENCY (default 5) callbacks
# at once. Callbacks run in subshells — they must not rely on mutating parent
# shell state (use POLL_LAUNCH_QUEUE + queue_or_launch_repo_job from worker.sh).
# A non-zero callback return is ignored so one failure does not abort the batch.
ai_foreach_project_parallel() {
    local projects_file="$1"
    local callback="$2"
    local concurrency="${3:-${POLL_CONCURRENCY:-5}}"
    local entry project project_dir block_on_open_pr full_name remote_url
    local -a pids=()
    local pid

    if [[ ! -f "$projects_file" ]]; then
        return 0
    fi

    if ! [[ "$concurrency" =~ ^[1-9][0-9]*$ ]]; then
        concurrency=5
    fi

    while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
        [[ -z "$entry" ]] && continue

        project="$(jq -r '.name // empty' <<<"$entry")"
        project_dir="$(jq -r '.path // empty' <<<"$entry")"
        full_name="$(jq -r '.full_name // .repo // empty' <<<"$entry")"
        remote_url="$(jq -r '.remote_url // empty' <<<"$entry")"
        block_on_open_pr="$(ai_project_entry_bool "$entry" "block_on_open_pr" 1)"

        if ! ai_validate_project_dir "$project" "$project_dir" 1; then
            if [[ -z "$full_name" && -z "$remote_url" ]]; then
                continue
            fi
        fi

        while (( ${#pids[@]} >= concurrency )); do
            wait -n 2>/dev/null || {
                # Bash without wait -n: wait for the oldest child.
                if [[ "${#pids[@]}" -gt 0 ]]; then
                    wait "${pids[0]}" 2>/dev/null || true
                fi
            }
            ai_reap_pid_array pids
        done

        (
            "$callback" "$project" "$project_dir" "$block_on_open_pr" "$entry" || true
        ) &
        pids+=($!)
    done < <(ai_list_project_entries "$projects_file")

    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done

    return 0
}

# Multi-worker short lease before flipping forge labels (ai -> ai-working, etc.).
# Uses Postgres via the web API (no Redis). Default TTL 10s.
# Usage: ai_try_claim_repo_lock <github|gitlab> <full_name> [task_type] [external_id]
# Returns:
#   0 — claimed, renewed, or no control plane (proceed; local flock still applies)
#   1 — another worker holds the claim (caller must skip)
ai_try_claim_repo_lock() {
    local forge="$1"
    local full_name="$2"
    local task_type="${3:-}"
    local external_id="${4:-}"
    local ttl="${REPO_CLAIM_TTL_SECONDS:-10}"
    local web_url token holder payload body claimed

    web_url="${WEB_INTERNAL_URL:-}"
    token="${WORKER_INTERNAL_TOKEN:-}"
    if [[ -z "$web_url" || -z "$token" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Repo claim skipped (no control plane); relying on local locks/labels."
        return 0
    fi

    if [[ -z "$forge" || -z "$full_name" ]]; then
        echo "WARNING: ai_try_claim_repo_lock requires forge and full_name" >&2
        return 1
    fi

    if ! [[ "$ttl" =~ ^[1-9][0-9]*$ ]]; then
        ttl=10
    fi

    holder="${WORKER_CLAIM_HOLDER:-$(hostname 2>/dev/null || echo worker)-$$}"

    payload="$(jq -n \
        --arg forge "$forge" \
        --arg full "$full_name" \
        --arg holder "$holder" \
        --argjson ttl "$ttl" \
        --arg task "$task_type" \
        --arg ext "$external_id" \
        '{
            forgeType: $forge,
            fullName: $full,
            holder: $holder,
            ttlSeconds: $ttl
        }
        + (if $task == "" then {} else {taskType: $task} end)
        + (if $ext == "" then {} else {externalId: $ext} end)')"

    body="$(
        curl -fsS -X POST \
            -H "Content-Type: application/json" \
            -H "x-worker-token: $token" \
            -d "$payload" \
            "${web_url}/api/v1/worker/internal/claim-repo" 2>/dev/null || true
    )"

    if [[ -z "$body" ]]; then
        echo "WARNING: Repo claim API unreachable for $full_name; skipping job to avoid duplicate multi-worker work." >&2
        return 1
    fi

    claimed="$(jq -r '.claimed // false' <<<"$body" 2>/dev/null || echo false)"
    if [[ "$claimed" == "true" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Claimed repo lock ${forge}:${full_name} for ${ttl}s (holder=${holder})"
        return 0
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Repo ${forge}:${full_name} already claimed by $(jq -r '.holder // "another worker"' <<<"$body"); skipping."
    return 1
}

# Report a task run to the platform DB (best-effort).
# Usage: ai_report_task_run <json-fields...> via env-style args in a single JSON object string.
# Example:
#   ai_report_task_run '{"forgeType":"github","taskType":"github_issue","externalId":"12","status":"running",...}'
ai_report_task_run() {
    local payload="${1:-}"
    local web_url token

    web_url="${WEB_INTERNAL_URL:-}"
    token="${WORKER_INTERNAL_TOKEN:-}"
    if [[ -z "$web_url" || -z "$token" || -z "$payload" ]]; then
        return 0
    fi

    curl -fsS -X POST \
        -H "Content-Type: application/json" \
        -H "x-worker-token: $token" \
        -d "$payload" \
        "${web_url}/api/v1/worker/internal/runs" >/dev/null 2>&1 || true
}

# Ask the platform to clone a managed workspace if missing.
# Usage: ai_ensure_project_workspace <project_dir> <project_name> [forge] [full_name]
# Returns:
#   0 — workspace ready (platform status ready AND local checkout validates)
#   2 — clone queued/in progress (caller should skip this cycle; fair to other repos)
#   1 — hard failure
# Only called after AI work is found. Waits briefly for the clone so a fresh
# environment is ready before the agent starts. Override with AI_ENSURE_WAIT_SECONDS
# (0 = single poll, return 2 if still pending).
# Requires WEB_INTERNAL_URL + WORKER_INTERNAL_TOKEN (set by platform-wrapper).
ai_ensure_project_workspace() {
    local project_dir="$1"
    local project_name="$2"
    local forge="${3:-}"
    local full_name="${4:-}"
    local web_url token payload status body err
    # Default 180s: enough for a typical lazy clone before starting the agent.
    local wait_seconds="${AI_ENSURE_WAIT_SECONDS:-180}"
    local attempt max_attempts sleep_s=5

    web_url="${WEB_INTERNAL_URL:-}"
    token="${WORKER_INTERNAL_TOKEN:-}"
    if [[ -z "$web_url" || -z "$token" ]]; then
        # No control plane: fall back to local checkout only.
        if ai_validate_project_dir "$project_name" "$project_dir" 1; then
            return 0
        fi
        echo "WARNING: Cannot lazy-clone $project_name (WEB_INTERNAL_URL / WORKER_INTERNAL_TOKEN unset)" >&2
        return 1
    fi

    payload="$(jq -n \
        --arg path "$project_dir" \
        --arg name "$project_name" \
        --arg forge "$forge" \
        --arg full "$full_name" \
        '{
            path: $path,
            name: $name
        }
        + (if $forge == "" then {} else {forgeType: $forge} end)
        + (if $full == "" then {} else {fullName: $full} end)')"

    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Ensuring workspace for $project_name (lazy clone)…"

    max_attempts=1
    if [[ "$wait_seconds" =~ ^[0-9]+$ ]] && [[ "$wait_seconds" -gt 0 ]]; then
        max_attempts=$(( (wait_seconds + sleep_s - 1) / sleep_s ))
        (( max_attempts < 1 )) && max_attempts=1
    fi

    for ((attempt = 1; attempt <= max_attempts; attempt++)); do
        body="$(
            curl -fsS -X POST \
                -H "Content-Type: application/json" \
                -H "x-worker-token: $token" \
                -d "$payload" \
                "${web_url}/api/v1/worker/internal/ensure-workspace" 2>/dev/null || true
        )"
        status="$(jq -r '.workspaceStatus // empty' <<<"$body" 2>/dev/null || true)"
        err="$(jq -r '.lastError // empty' <<<"$body" 2>/dev/null || true)"

        # Require platform "ready" AND a usable local checkout. A partial in-flight
        # clone can create .git before finishing (or failing); never trust local alone.
        if [[ "$status" == "ready" ]] && ai_validate_project_dir "$project_name" "$project_dir" 1; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Workspace ready for $project_name"
            return 0
        fi

        if [[ "$status" == "failed" || "$status" == "inaccessible" ]]; then
            echo "ERROR: Workspace ensure failed for $project_name (status=$status)${err:+: $err}" >&2
            return 1
        fi

        if (( attempt < max_attempts )); then
            sleep "$sleep_s"
        fi
    done

    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Clone pending for $project_name (status=${status:-unknown}); will retry next cycle"
    return 2
}

# Return 0 if staged/changed file list looks like secrets.
# Allows env templates (.env.example / .env.sample / .env.template).
ai_has_secret_files() {
    local changed_files="$1"
    local path base

    while IFS= read -r path || [[ -n "$path" ]]; do
        [[ -z "$path" ]] && continue
        base="${path##*/}"

        case "$base" in
            .env.example|.env.sample|.env.template)
                continue
                ;;
            .env|.env.*|*.pem|*.key|id_rsa|id_ed25519)
                return 0
                ;;
        esac
    done <<<"$changed_files"

    return 1
}

ai_log_banner() {
    local title="$1"
    echo
    echo "============================================================"
    echo "                    $title"
    echo "============================================================"
}

# Truncate text to max bytes; append a marker when truncated.
ai_trim_text() {
    local text="$1"
    local max_bytes="${2:-20000}"
    local bytes

    bytes="$(printf '%s' "$text" | wc -c | tr -d ' ')"
    if [[ "$bytes" -le "$max_bytes" ]]; then
        printf '%s' "$text"
        return 0
    fi

    printf '%s' "$text" | head -c "$max_bytes"
    printf '\n... [truncated] ...'
}

# True when a comment body looks like an automated ai-review post.
ai_is_automation_review_comment() {
    local body="$1"
    [[ "$body" == *"Label \`ai-review\` was processed automatically"* ]] \
        || [[ "$body" == *"Label 'ai-review' was processed automatically"* ]]
}

# Map GitHub collaborator permission to a review role label.
ai_github_permission_to_role() {
    case "${1:-}" in
        admin) printf 'maintainer' ;;
        maintain) printf 'maintainer' ;;
        write) printf 'developer' ;;
        triage) printf 'developer' ;;
        read) printf 'reporter' ;;
        *) printf 'unknown' ;;
    esac
}

# Resolve a user's repo role for review context. Empty on failure.
ai_github_get_user_repo_role() {
    local repo="$1"
    local username="$2"
    local permission

    if [[ -z "$username" ]]; then
        return 1
    fi

    permission="$(
        gh api \
            "repos/${repo}/collaborators/${username}/permission" \
            --jq '.permission // empty' \
            2>/dev/null || true
    )"

    if [[ -z "$permission" ]]; then
        return 1
    fi

    ai_github_permission_to_role "$permission"
}

# Format a normalized discussion item array [{kind, author, role, created_at, body, is_ai_review}].
ai_format_discussion_items_text() {
    local items_json="$1"
    local max_bytes="${2:-30000}"

    if [[ -z "$items_json" || "$items_json" == "[]" || "$items_json" == "null" ]]; then
        printf '%s' "(no comments)"
        return 0
    fi

    ai_trim_text "$(
        jq -r '
            if length == 0 then "(no comments)"
            else map(
                if (.role // "") != "" and .role != "unknown" then
                    if .is_ai_review then
                        "--- \(.kind // "comment") by \(.author) (automated AI review) at \(.created_at) ---\n\(.body // "")\n"
                    else
                        "--- \(.kind // "comment") by \(.author) (\(.role)) at \(.created_at) ---\n\(.body // "")\n"
                    end
                elif .is_ai_review then
                    "--- \(.kind // "comment") by \(.author) (automated AI review) at \(.created_at) ---\n\(.body // "")\n"
                else
                    "--- \(.kind // "comment") by \(.author) at \(.created_at) ---\n\(.body // "")\n"
                end
            ) | join("\n")
            end
        ' <<<"$items_json"
    )" "$max_bytes"
}

# Split discussion into full thread and comments after the last automated AI review.
# Writes text to output files (safe for multiline content). Sets rounds_var if provided.
ai_split_discussion_items_to_files() {
    local items_json="$1"
    local full_file="$2"
    local since_file="$3"
    local rounds_var="${4:-}"

    local since_items ai_rounds full_text since_text

    if [[ -z "$items_json" || "$items_json" == "[]" || "$items_json" == "null" ]]; then
        printf '%s' "(no comments)" > "$full_file"
        printf '%s' "(no new comments since the last AI review)" > "$since_file"
        if [[ -n "$rounds_var" ]]; then
            printf -v "$rounds_var" '%s' "0"
        fi
        return 0
    fi

    ai_rounds="$(jq '[.[] | select(.is_ai_review == true)] | length' <<<"$items_json")"

    since_items="$(
        jq '
            [to_entries[] | select(.value.is_ai_review == true) | .key] as $ai_idxs |
            if ($ai_idxs | length) == 0 then []
            else .[($ai_idxs | max + 1):]
            end
        ' <<<"$items_json"
    )"

    full_text="$(ai_format_discussion_items_text "$items_json" 30000)"
    since_text="$(ai_format_discussion_items_text "$since_items" 15000)"

    if [[ "$since_text" == "(no comments)" ]]; then
        since_text="(no new comments since the last AI review)"
    fi

    printf '%s' "$full_text" > "$full_file"
    printf '%s' "$since_text" > "$since_file"

    if [[ -n "$rounds_var" ]]; then
        printf -v "$rounds_var" '%s' "$ai_rounds"
    fi
}

# Log a readable table of discussion items for debugging (main worker log).
ai_log_discussion_items_table() {
    local items_json="$1"
    local title="${2:-Discussion items}"

    if [[ -z "$items_json" || "$items_json" == "[]" || "$items_json" == "null" ]]; then
        echo
        echo "============================================================"
        echo "$title"
        echo "============================================================"
        echo "(no discussion items)"
        return 0
    fi

    echo
    echo "============================================================"
    echo "$title"
    echo "============================================================"
    jq -r '
        to_entries[] |
        "[\(.key)] \(.value.created_at) author=\(.value.author) role=\(.value.role) ai_review=\(.value.is_ai_review)\n  preview: \(.value.body | .[0:200] | gsub("\r"; "") | gsub("\n"; " "))"
    ' <<<"$items_json"
}

# Log human comments since the last automated AI review.
ai_log_human_comments_since_last_ai() {
    local items_json="$1"

    echo
    echo "------------------------------------------------------------"
    echo "Human comments since last automated AI review (fed to prompt)"
    echo "------------------------------------------------------------"

    local human_since
    human_since="$(
        jq '
            [to_entries[] | select(.value.is_ai_review == true) | .key] as $ai_idxs |
            if ($ai_idxs | length) == 0 then . else .[($ai_idxs | max + 1):] end |
            [.[] | select(.is_ai_review != true)]
        ' <<<"$items_json"
    )"

    if [[ "$human_since" == "[]" || -z "$human_since" ]]; then
        echo "(none — prompt SINCE_LAST section will be empty or placeholder)"
        ai_log_worker_star_line
        ai_echo_worker "PICKED COMMENTS (since last AI review): (none)"
        return 0
    fi

    ai_log_worker_star_line
    ai_echo_worker "PICKED COMMENTS (since last AI review) — fed to SINCE_LAST_AI prompt section:"

    while IFS= read -r line || [[ -n "$line" ]]; do
        ai_echo_worker "$line"
    done < <(
        jq -r '
            .[] |
            "--- \(.author) (\(.role)) at \(.created_at) ---\n\(.body)\n"
        ' <<<"$human_since"
    )
}

# Build normalized discussion items from GitLab MR/issue notes.
ai_gitlab_discussion_items_from_notes() {
    local project_path="$1"
    local notes_json="$2"
    local enriched="$notes_json"

    if [[ -n "$project_path" ]]; then
        enriched="$(gitlab_enrich_notes_with_roles "$project_path" "$notes_json")"
        if [[ -z "$enriched" ]]; then
            enriched="$notes_json"
        fi
    fi

    jq '
        map({
            kind: "comment",
            author: (.author.username // .author.name // "unknown"),
            role: (.review_role // "unknown"),
            created_at: .created_at,
            body: (.body // ""),
            is_ai_review: (
                (.body // "") | (contains("was processed automatically") and contains("ai-review"))
            )
        })
    ' <<<"${enriched:-[]}"
}

# Enrich GitHub issue/PR comments with repo roles.
ai_enrich_github_comments_with_roles() {
    local repo="$1"
    local comments_json="$2"
    local username role role_map="{}"

    if [[ -z "$comments_json" || "$comments_json" == "[]" || "$comments_json" == "null" ]]; then
        printf '[]'
        return 0
    fi

    while IFS= read -r username; do
        [[ -z "$username" ]] && continue
        role="$(ai_github_get_user_repo_role "$repo" "$username" 2>/dev/null || true)"
        if [[ -n "$role" ]]; then
            role_map="$(jq -c --arg u "$username" --arg role "$role" '. + {($u): $role}' <<<"$role_map")"
        fi
    done < <(jq -r '.[].user.login // empty' <<<"$comments_json" | sort -u)

    local enriched
    if ! enriched="$(jq --argjson roles "$role_map" '
        map(
            . + {
                review_role: ($roles[.user.login // ""] // "unknown")
            }
        )
    ' <<<"$comments_json")"; then
        echo "WARNING: Could not enrich GitHub comments with roles (jq failed); using raw comments." >&2
        printf '%s' "$comments_json"
        return 0
    fi

    if [[ -z "$enriched" ]]; then
        printf '%s' "$comments_json"
        return 0
    fi

    printf '%s' "$enriched"
}

# Build normalized discussion items for a GitHub pull request.
# Optional 3rd–5th args: pre-fetched issue / inline / review JSON (skips API calls).
ai_github_discussion_items_from_pr() {
    local repo="$1"
    local pr_number="$2"
    local issue_raw="${3:-}"
    local inline_raw="${4:-}"
    local reviews_raw="${5:-}"
    local issue_comments review_comments reviews

    if [[ -z "$issue_raw" ]]; then
        issue_raw="$(ai_github_fetch_issue_comments "$repo" "$pr_number")"
    fi
    if [[ -z "$inline_raw" ]]; then
        inline_raw="$(ai_github_fetch_pr_review_comments "$repo" "$pr_number")"
    fi
    if [[ -z "$reviews_raw" ]]; then
        reviews_raw="$(ai_github_fetch_pr_reviews "$repo" "$pr_number")"
    fi

    issue_comments="$(ai_enrich_github_comments_with_roles "$repo" "$issue_raw")"
    [[ -z "$issue_comments" ]] && issue_comments="$issue_raw"

    review_comments="$(ai_enrich_github_comments_with_roles "$repo" "$inline_raw")"
    [[ -z "$review_comments" ]] && review_comments="$inline_raw"

    reviews="$(ai_enrich_github_comments_with_roles "$repo" "$reviews_raw")"
    [[ -z "$reviews" ]] && reviews="$reviews_raw"

    jq -n \
        --argjson issue "$issue_comments" \
        --argjson inline "$review_comments" \
        --argjson reviews "$reviews" \
        '
        [
            ($issue | map({
                kind: "comment",
                author: (.user.login // "unknown"),
                role: (.review_role // "unknown"),
                created_at: .created_at,
                body: (.body // ""),
                is_ai_review: ((.body // "") | (contains("was processed automatically") and contains("ai-review")))
            })),
            ($inline | map({
                kind: "inline",
                author: (.user.login // "unknown"),
                role: (.review_role // "unknown"),
                created_at: .created_at,
                body: (
                    "On " + (.path // "unknown") +
                    (if .line then " line " + (.line|tostring) else "" end) +
                    ": " + (.body // "")
                ),
                is_ai_review: false
            })),
            ($reviews | map(select(.body != null and .body != "")) | map({
                kind: "review",
                author: (.user.login // "unknown"),
                role: (.review_role // "unknown"),
                created_at: .submitted_at,
                body: (.state // "commented") + ": " + (.body // ""),
                is_ai_review: ((.body // "") | (contains("was processed automatically") and contains("ai-review")))
            }))
        ] | add | sort_by(.created_at)
        '
}

# Extract unique issue numbers linked from title/description (GitHub).
ai_extract_github_linked_issue_numbers() {
    local text="$1"
    local matches

    if [[ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]]; then
        return 0
    fi

    matches="$(
        printf '%s\n' "$text" \
            | grep -oiE \
                '(closes?|closed|closing|fixes?|fixed|fixing|resolves?|resolved|resolving|implements?|implemented|implementing|related[[:space:]]+to|relates[[:space:]]+to)[[:space:]]+#[[:digit:]]+' \
            || true
    )"

    if [[ -z "$matches" ]]; then
        return 0
    fi

    printf '%s\n' "$matches" | grep -oE '[[:digit:]]+' | sort -n -u
}

# Build linked-issues text file for GitHub PR/MR prompts.
ai_build_github_linked_issues_file() {
    local repo="$1"
    local title="$2"
    local body="$3"
    local issues_file="$4"
    local linked_count_var="$5"
    local -n linked_count_ref="$linked_count_var"

    : > "$issues_file"
    linked_count_ref=0

    mapfile -t linked_numbers < <(
        ai_extract_github_linked_issue_numbers "${title}"$'\n'"${body}"
    )

    if [[ ${#linked_numbers[@]} -eq 0 ]]; then
        cat >> "$issues_file" <<EOF
No linked GitHub issues were found in the title or description.

Use PR/MR comments and the diff as the primary source of requirements.
EOF
        return 0
    fi

    for issue_number in "${linked_numbers[@]}"; do
        if ! issue_json="$(
            gh issue view "$issue_number" \
                --repo "$repo" \
                --json title,body,url,state,author,labels \
                2>/dev/null
        )"; then
            cat >> "$issues_file" <<EOF
------------------------------------------------------------
ISSUE #${issue_number}
------------------------------------------------------------

(Could not fetch this issue from the GitHub API.)

EOF
            continue
        fi

        linked_count_ref=$((linked_count_ref + 1))

        issue_title="$(jq -r '.title // ""' <<<"$issue_json")"
        issue_state="$(jq -r '.state // ""' <<<"$issue_json")"
        issue_url="$(jq -r '.url // ""' <<<"$issue_json")"
        issue_author="$(jq -r '.author.login // .author.name // "unknown"' <<<"$issue_json")"
        issue_labels="$(jq -r '[.labels[].name] | join(", ")' <<<"$issue_json")"
        issue_body="$(jq -r '.body // ""' <<<"$issue_json")"
        issue_comments_text="(no comments)"

        if issue_comments_json="$(ai_github_fetch_issue_comments "$repo" "$issue_number" 2>/dev/null)"; then
            issue_comments_text="$(ai_format_github_comments "$issue_comments_json" 10000 "$repo")"
        fi

        issue_body="$(ai_trim_text "$issue_body" 20000)"

        cat >> "$issues_file" <<EOF
------------------------------------------------------------
ISSUE #${issue_number}
------------------------------------------------------------

Title:  $issue_title
State:  $issue_state
Author: $issue_author
Labels: ${issue_labels:-none}
URL:    $issue_url

Description:
$issue_body

Comments (override description when they conflict):
$issue_comments_text

EOF
    done
}

# Build linked-issues text file for GitLab MR prompts.
ai_build_gitlab_linked_issues_file() {
    local repo_path="$1"
    local title="$2"
    local body="$3"
    local issues_file="$4"
    local linked_count_var="$5"
    local -n linked_count_ref="$linked_count_var"

    : > "$issues_file"
    linked_count_ref=0

    mapfile -t linked_iids < <(
        gitlab_extract_linked_issue_iids "${title}"$'\n'"${body}"
    )

    if [[ ${#linked_iids[@]} -eq 0 ]]; then
        cat >> "$issues_file" <<EOF
No linked GitLab issues were found in the title or description.

Use MR comments and the diff as the primary source of requirements.
EOF
        return 0
    fi

    for issue_iid in "${linked_iids[@]}"; do
        if ! issue_json="$(gitlab_get_issue "$repo_path" "$issue_iid" 2>/dev/null)"; then
            cat >> "$issues_file" <<EOF
------------------------------------------------------------
ISSUE #${issue_iid}
------------------------------------------------------------

(Could not fetch this issue from the GitLab API.)

EOF
            continue
        fi

        linked_count_ref=$((linked_count_ref + 1))

        issue_title="$(jq -r '.title // ""' <<<"$issue_json")"
        issue_state="$(jq -r '.state // ""' <<<"$issue_json")"
        issue_url="$(jq -r '.web_url // ""' <<<"$issue_json")"
        issue_author="$(jq -r '.author.username // .author.name // "unknown"' <<<"$issue_json")"
        issue_labels="$(jq -r '[.labels[]?] | join(", ")' <<<"$issue_json")"
        issue_body="$(jq -r '.description // ""' <<<"$issue_json")"
        issue_comments_text="(no comments)"

        if issue_notes_json="$(gitlab_list_issue_notes "$repo_path" "$issue_iid" 2>/dev/null)"; then
            issue_comments_text="$(gitlab_format_notes "$issue_notes_json" 10000 "$repo_path")"
        fi

        issue_body="$(ai_trim_text "$issue_body" 20000)"

        cat >> "$issues_file" <<EOF
------------------------------------------------------------
ISSUE #${issue_iid}
------------------------------------------------------------

Title:  $issue_title
State:  $issue_state
Author: $issue_author
Labels: ${issue_labels:-none}
URL:    $issue_url

Description:
$issue_body

Comments (override description when they conflict):
$issue_comments_text

EOF
    done
}

# Format GitHub issue/PR comment JSON (array) into readable chronological text.
ai_format_github_comments() {
    local comments_json="$1"
    local max_bytes="${2:-30000}"
    local repo="${3:-}"
    local enriched="$comments_json"

    if [[ -n "$repo" ]]; then
        enriched="$(ai_enrich_github_comments_with_roles "$repo" "$comments_json")"
        if [[ -z "$enriched" ]]; then
            enriched="$comments_json"
        fi
    fi

    if [[ -z "$enriched" || "$enriched" == "[]" || "$enriched" == "null" ]]; then
        printf '%s' "(no comments)"
        return 0
    fi

    ai_trim_text "$(
        jq -r '
            sort_by(.created_at) |
            if length == 0 then "(no comments)"
            else map(
                if (.review_role? // "") != "" and .review_role != "unknown" then
                    "--- Comment by \(.user.login // "unknown") (\(.review_role)) at \(.created_at) ---\n\(.body // "")\n"
                else
                    "--- Comment by \(.user.login // "unknown") at \(.created_at) ---\n\(.body // "")\n"
                end
            ) | join("\n")
            end
        ' <<<"$enriched"
    )" "$max_bytes"
}

# Print oldest open issue number with label "ai", or empty.
github_find_ai_issue() {
    local repo="$1"

    gh issue list \
        --repo "$repo" \
        --label "ai" \
        --state open \
        --limit 1 \
        --json number \
        --jq '.[0].number // empty' \
        2>/dev/null || true
}

# AI implement-workflow labels on an open PR that should block starting a new
# `ai` issue (human PRs without these labels / ai/issue-* heads do not block).
GITHUB_AI_IN_FLIGHT_PR_LABELS=(ai ai-working ai-failed ai-pr)

# List open PRs via repository GraphQL (NOT Search).
# Do not pass --label: that forces GitHub Search (low rate limit / silent 403s).
# Usage: github_list_open_prs_json <owner/repo> [limit]
github_list_open_prs_json() {
    local repo="$1"
    local limit="${2:-100}"
    local out

    out="$(
        gh pr list \
            --repo "$repo" \
            --state open \
            --limit "$limit" \
            --json number,headRefName,createdAt,labels \
            2>/dev/null || true
    )"
    if [[ -z "$out" || "$out" == "null" ]]; then
        printf '%s' '[]'
        return 0
    fi
    printf '%s' "$out"
}

# True if a head/source branch is an AI issue branch (ai/issue-N or ai/issue-N-*).
github_is_ai_issue_branch() {
    local branch="$1"
    [[ "$branch" =~ ^ai/issue-[0-9]+(-|$) ]]
}

# Print a short description of the oldest open PR that should block a new issue,
# or empty. Matches AI implement labels OR head branch ai/issue-* (safety net when
# label application failed). Example: "#12 (ai/issue-3, ai-pr)"
github_find_open_pr() {
    local repo="$1"
    local prs

    prs="$(github_list_open_prs_json "$repo" 100)"

    jq -r '
        def in_flight_labels: ["ai","ai-working","ai-failed","ai-pr"];
        def label_names:
            [(.labels // [])[] | (if type == "object" then (.name // "") else . end) | ascii_downcase]
            | map(select(length > 0));
        # Use null (not empty) so unlabeled PRs still continue through the pipeline.
        def matching_label:
            label_names as $names
            | (in_flight_labels
               | map(select(. as $l | ($names | index($l)) != null))
               | .[0] // null);
        def is_ai_branch:
            ((.headRefName // "") | test("^ai/issue-[0-9]+(-|$)"));
        [
            .[]
            | . as $pr
            | ($pr | matching_label) as $lbl
            | select(($lbl != null) or ($pr | is_ai_branch))
            | {
                number: $pr.number,
                headRefName: ($pr.headRefName // "unknown"),
                createdAt: ($pr.createdAt // ""),
                label: (if $lbl != null then $lbl else "ai-branch" end)
              }
        ]
        | sort_by(.createdAt)
        | .[0]
        | if . == null then empty
          else "#\(.number) (\(.headRefName), \(.label))"
          end
    ' <<<"$prs" 2>/dev/null || true
}

# Oldest open PR number with a given label (client-side filter; avoids Search).
# Usage: github_find_open_pr_with_label <owner/repo> <label>
github_find_open_pr_with_label() {
    local repo="$1"
    local label="$2"
    local prs wanted

    wanted="$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]')"
    prs="$(github_list_open_prs_json "$repo" 100)"

    jq -r --arg want "$wanted" '
        [
            .[]
            | select(
                [(.labels // [])[] | (if type == "object" then (.name // "") else . end) | ascii_downcase]
                | index($want) != null
              )
        ]
        | sort_by(.createdAt)
        | .[0].number // empty
    ' <<<"$prs" 2>/dev/null || true
}

# Add labels to a GitHub issue or PR (PR numbers share the issues labels API).
# Usage: github_add_labels <owner/repo> <number> <label> [label...]
github_add_labels() {
    local repo="$1"
    local number="$2"
    shift 2
    local label payload

    if [[ $# -lt 1 ]]; then
        echo "ERROR: github_add_labels requires at least one label" >&2
        return 1
    fi

    payload="$(jq -n --args '{labels: $ARGS.positional}' -- "$@")"
    gh api \
        --method POST \
        "repos/${repo}/issues/${number}/labels" \
        --input - <<<"$payload" \
        >/dev/null
}

# Ensure a pull request carries label ai-pr (create-time + REST fallback).
# Usage: github_ensure_pr_has_ai_pr_label <owner/repo> <pr_number>
github_ensure_pr_has_ai_pr_label() {
    local repo="$1"
    local pr_number="$2"
    local has

    has="$(
        gh pr view "$pr_number" \
            --repo "$repo" \
            --json labels \
            --jq '[.labels[].name | ascii_downcase] | any(. == "ai-pr")' \
            2>/dev/null || echo false
    )"
    if [[ "$has" == "true" ]]; then
        return 0
    fi

    if gh pr edit "$pr_number" --repo "$repo" --add-label "ai-pr" >/dev/null 2>&1; then
        return 0
    fi

    if github_add_labels "$repo" "$pr_number" "ai-pr"; then
        return 0
    fi

    echo "WARNING: Could not add ai-pr label to pull request #${pr_number}." >&2
    return 1
}

# Label open PRs whose head is ai/issue-N or ai/issue-N-* with ai-pr.
# Usage: github_label_open_issue_prs_ai_pr <repo> <issue_number>
github_label_open_issue_prs_ai_pr() {
    local repo="$1"
    local issue_number="$2"
    local prefix="ai/issue-${issue_number}"
    local pr_num

    while IFS= read -r pr_num; do
        [[ -n "$pr_num" ]] || continue
        echo "Adding ai-pr label to pull request #$pr_num"
        if ! github_ensure_pr_has_ai_pr_label "$repo" "$pr_num"; then
            echo "WARNING: Could not add ai-pr to PR #$pr_num"
        fi
    done < <(
        github_list_open_prs_json "$repo" 50 \
            | jq -r --arg p "$prefix" '
                .[]
                | select(
                    .headRefName == $p
                    or (.headRefName | startswith($p + "-"))
                  )
                | .number
              ' || true
    )
}

# Fetch all issue/PR discussion comments from GitHub (chronological).
ai_github_fetch_issue_comments() {
    local repo="$1"
    local number="$2"

    gh api \
        --paginate \
        "repos/${repo}/issues/${number}/comments" \
        2>/dev/null \
        | jq -s 'add // []' \
        || printf '[]'
}

# Fetch inline review comments on a pull request.
ai_github_fetch_pr_review_comments() {
    local repo="$1"
    local pr_number="$2"

    gh api \
        --paginate \
        "repos/${repo}/pulls/${pr_number}/comments" \
        2>/dev/null \
        | jq -s 'add // []' \
        || printf '[]'
}

# Fetch submitted PR reviews (approve/request changes summaries).
ai_github_fetch_pr_reviews() {
    local repo="$1"
    local pr_number="$2"

    gh api \
        --paginate \
        "repos/${repo}/pulls/${pr_number}/reviews" \
        2>/dev/null \
        | jq -s 'add // []' \
        || printf '[]'
}

# Build one text block for all GitHub PR/MR discussion (issue comments + inline + reviews).
ai_github_format_pr_discussion() {
    local repo="$1"
    local pr_number="$2"
    local max_bytes="${3:-30000}"
    local issue_comments review_comments reviews combined

    issue_comments="$(ai_github_fetch_issue_comments "$repo" "$pr_number")"
    review_comments="$(ai_github_fetch_pr_review_comments "$repo" "$pr_number")"
    reviews="$(ai_github_fetch_pr_reviews "$repo" "$pr_number")"

    combined="$(
        jq -n \
            --argjson issue "$issue_comments" \
            --argjson inline "$review_comments" \
            --argjson reviews "$reviews" \
            '
            [
                ($issue | map({
                    kind: "comment",
                    created_at: .created_at,
                    author: (.user.login // "unknown"),
                    body: (.body // "")
                })),
                ($inline | map({
                    kind: "inline",
                    created_at: .created_at,
                    author: (.user.login // "unknown"),
                    body: (
                        "On " + (.path // "unknown") +
                        (if .line then " line " + (.line|tostring) else "" end) +
                        ": " + (.body // "")
                    )
                })),
                ($reviews | map(select(.body != null and .body != "")) | map({
                    kind: "review",
                    created_at: .submitted_at,
                    author: (.user.login // "unknown"),
                    body: (.state // "commented") + ": " + (.body // "")
                }))
            ] | add | sort_by(.created_at) |
            if length == 0 then "(no comments)"
            else map(
                "--- \(.kind) by \(.author) at \(.created_at) ---\n\(.body)\n"
            ) | join("\n")
            end
            '
    )"

    ai_trim_text "$combined" "$max_bytes"
}

# Filenames the agent may write for automation (never commit these).
ai_implement_notes_basenames() {
    printf '%s\n' \
        '.ai-pr-notes.md' \
        '.ai-mr-notes.md' \
        '.ai-pr-review.md' \
        '.ai-mr-review.md' \
        '.ai-issue-answer.md' \
        '.ai-related-tasks.json'
}

# Move implement notes out of the project tree before git add/commit.
# Usage: ai_capture_implement_notes <notes_file> <saved_path>
# Returns 0 if a non-empty notes file was captured, 1 otherwise.
ai_capture_implement_notes() {
    local notes_file="$1"
    local saved_path="$2"
    local bytes

    if [[ -z "$notes_file" || -z "$saved_path" ]]; then
        return 1
    fi

    if [[ ! -f "$notes_file" ]]; then
        echo "WARNING: Implement notes file missing: $notes_file" >&2
        echo "WARNING: No merge/PR notes comment will be posted." >&2
        return 1
    fi

    bytes="$(wc -c < "$notes_file" | tr -d ' ')"
    if [[ "$bytes" -eq 0 ]]; then
        echo "WARNING: Implement notes file is empty: $notes_file" >&2
        rm -f "$notes_file"
        return 1
    fi

    mkdir -p "$(dirname "$saved_path")"
    cp "$notes_file" "$saved_path"
    rm -f "$notes_file"

    # Safety: drop any leftover automation artifacts before staging.
    if [[ -n "${PROJECT_DIR:-}" ]]; then
        ai_remove_ai_artifact_files "$PROJECT_DIR"
    fi

    echo "Captured implement notes ($bytes bytes) -> $saved_path" >&2
    return 0
}

# True when captured notes explain a declined / no-code-change run.
# Usage: ai_notes_explain_no_implementation <notes_path>
ai_notes_explain_no_implementation() {
    local notes_file="$1"

    [[ -n "$notes_file" && -f "$notes_file" ]] || return 1
    if grep -qiE '^##[[:space:]]+Why this was not implemented' "$notes_file"; then
        return 0
    fi
    # Prompt decline template uses ## Summary + explicit no-code / wrong-repo language.
    if grep -qiE '^##[[:space:]]+Summary' "$notes_file" \
        && grep -qiE \
            '(unrelated to this repository|not acceptable|not useful|no code changes|empty pull/?merge request|declined)' \
            "$notes_file"
    then
        return 0
    fi
    return 1
}

# Human-readable explanation for known runner exit codes.
# Usage: ai_describe_runner_exit_code <exit_code>
ai_describe_runner_exit_code() {
    local code="${1:-}"

    case "$code" in
        10) printf '%s\n' 'Could not resolve the forge project or repository reference.' ;;
        11) printf '%s\n' 'Could not determine the forge repository for this workspace.' ;;
        12) printf '%s\n' 'Workspace prepare failed (main branch was not clean or checkout failed).' ;;
        13) printf '%s\n' 'Required source branch or issue context was missing.' ;;
        20) printf '%s\n' 'The AI agent finished successfully but made no product-file changes.' ;;
        130) printf '%s\n' 'The run was interrupted (SIGINT).' ;;
        143) printf '%s\n' 'The run was terminated (SIGTERM).' ;;
        '') printf '%s\n' 'The AI worker run failed for an unknown reason.' ;;
        *)
            if [[ "$code" =~ ^[0-9]+$ ]] && [[ "$code" -ne 0 ]]; then
                printf '%s\n' "The AI agent or runner failed (exit code ${code})."
            else
                printf '%s\n' 'The AI worker run failed.'
            fi
            ;;
    esac
}

# Newest file matching a glob (by mtime). Prints path or nothing.
# Usage: ai_latest_glob_match <glob>
ai_latest_glob_match() {
    local pattern="$1"
    local newest="" f

    shopt -s nullglob
    for f in $pattern; do
        if [[ -z "$newest" || "$f" -nt "$newest" ]]; then
            newest="$f"
        fi
    done
    shopt -u nullglob

    [[ -n "$newest" ]] || return 1
    printf '%s\n' "$newest"
}

# Extract the last ERROR block from a runner log (best-effort).
# Usage: ai_extract_log_error_excerpt <log_file> [max_chars]
ai_extract_log_error_excerpt() {
    local log_file="$1"
    local max_chars="${2:-1200}"
    local excerpt

    [[ -n "$log_file" && -f "$log_file" ]] || return 1

    excerpt="$(
        awk '
            BEGIN { collecting = 0; block = ""; last = "" }
            /^ERROR([:]|[[:space:]]|$)/ {
                if (block != "") last = block
                block = $0
                collecting = 1
                next
            }
            collecting {
                if ($0 ~ /^====/ || $0 ~ /^Finished:/ || $0 ~ /^Changing labels:/) {
                    last = block
                    block = ""
                    collecting = 0
                    next
                }
                if (length(block) < 2000) block = block "\n" $0
                next
            }
            END {
                if (block != "") last = block
                if (last != "") print last
            }
        ' "$log_file"
    )"

    [[ -n "$excerpt" ]] || return 1
    ai_trim_text "$excerpt" "$max_chars"
}

# Build markdown body for an ai-failed / ai-review-failed comment.
# Usage: ai_format_failure_comment <exit_code> <retry_label> [log_file] [notes_file]
ai_format_failure_comment() {
    local exit_code="$1"
    local retry_label="$2"
    local log_file="${3:-}"
    local notes_file="${4:-}"
    local reason excerpt notes_body

    reason="$(ai_describe_runner_exit_code "$exit_code")"
    excerpt=""
    notes_body=""

    if [[ -n "$log_file" && -f "$log_file" ]]; then
        excerpt="$(ai_extract_log_error_excerpt "$log_file" 1200 2>/dev/null || true)"
    fi
    if [[ -n "$notes_file" && -f "$notes_file" && -s "$notes_file" ]]; then
        notes_body="$(ai_trim_text "$(cat "$notes_file")" 2000)"
    fi

    cat <<EOF
<!-- ai-worker-failure -->
## AI Worker failed

**Reason:** ${reason}

EOF

    if [[ -n "$excerpt" && "$excerpt" != "$reason" ]]; then
        cat <<EOF
### Details from the run log

\`\`\`
${excerpt}
\`\`\`

EOF
    fi

    if [[ -n "$notes_body" ]]; then
        cat <<EOF
### Notes from the agent

${notes_body}

EOF
    fi

    cat <<EOF
The issue/PR was labeled \`ai-failed\` (or \`ai-review-failed\`) and was **not** retried automatically.

When ready, add the \`${retry_label}\` label to try again.
EOF
}

# Post a failure-reason comment on a GitHub issue or pull request.
# Usage: ai_post_github_failure_comment <issue|pr> <repo> <number> <exit_code> <retry_label> [log_glob] [notes_glob]
ai_post_github_failure_comment() {
    local kind="$1"
    local repo="$2"
    local number="$3"
    local exit_code="$4"
    local retry_label="$5"
    local log_glob="${6:-}"
    local notes_glob="${7:-}"
    local log_file="" notes_file="" comment_file comment_url

    if [[ -n "$log_glob" ]]; then
        log_file="$(ai_latest_glob_match "$log_glob" 2>/dev/null || true)"
    fi
    if [[ -n "$notes_glob" ]]; then
        notes_file="$(ai_latest_glob_match "$notes_glob" 2>/dev/null || true)"
    fi

    comment_file="$(mktemp)"
    ai_format_failure_comment "$exit_code" "$retry_label" "$log_file" "$notes_file" > "$comment_file"

    echo "Posting failure reason comment to GitHub ${kind} #${number}..." >&2
    if [[ "$kind" == "pr" ]]; then
        comment_url="$(
            gh pr comment "$number" \
                --repo "$repo" \
                --body-file "$comment_file" 2>/dev/null || true
        )"
    else
        comment_url="$(
            gh issue comment "$number" \
                --repo "$repo" \
                --body-file "$comment_file" 2>/dev/null || true
        )"
    fi
    rm -f "$comment_file"

    if [[ -z "$comment_url" ]]; then
        echo "WARNING: Could not post GitHub failure comment." >&2
        return 1
    fi

    echo "Failure comment posted: $comment_url" >&2
    printf '%s\n' "$comment_url"
    return 0
}

# Post a failure-reason note on a GitLab issue or merge request.
# Usage: ai_post_gitlab_failure_comment <issue|mr> <project_path> <iid> <exit_code> <retry_label> [log_glob] [notes_glob]
ai_post_gitlab_failure_comment() {
    local kind="$1"
    local project_path="$2"
    local iid="$3"
    local exit_code="$4"
    local retry_label="$5"
    local log_glob="${6:-}"
    local notes_glob="${7:-}"
    local log_file="" notes_file="" body note_json note_id note_url

    if [[ -n "$log_glob" ]]; then
        log_file="$(ai_latest_glob_match "$log_glob" 2>/dev/null || true)"
    fi
    if [[ -n "$notes_glob" ]]; then
        notes_file="$(ai_latest_glob_match "$notes_glob" 2>/dev/null || true)"
    fi

    body="$(ai_format_failure_comment "$exit_code" "$retry_label" "$log_file" "$notes_file")"

    echo "Posting failure reason comment to GitLab ${kind} !/${iid}..." >&2
    if [[ "$kind" == "mr" ]]; then
        if ! declare -F gitlab_create_mr_note >/dev/null 2>&1; then
            echo "WARNING: gitlab_create_mr_note unavailable; cannot post failure comment." >&2
            return 1
        fi
        note_json="$(gitlab_create_mr_note "$project_path" "$iid" "$body" 2>/dev/null || true)"
    else
        if ! declare -F gitlab_create_issue_note >/dev/null 2>&1; then
            echo "WARNING: gitlab_create_issue_note unavailable; cannot post failure comment." >&2
            return 1
        fi
        note_json="$(gitlab_create_issue_note "$project_path" "$iid" "$body" 2>/dev/null || true)"
    fi

    note_id="$(jq -r '.id // empty' <<<"${note_json:-}" 2>/dev/null || true)"
    if [[ -z "$note_id" ]]; then
        echo "WARNING: Could not post GitLab failure comment." >&2
        return 1
    fi

    note_url="$(jq -r '.web_url // empty' <<<"$note_json" 2>/dev/null || true)"
    echo "Failure comment posted (note id: $note_id)" >&2
    if [[ -n "$note_url" ]]; then
        printf '%s\n' "$note_url"
    else
        printf '%s\n' "$note_id"
    fi
    return 0
}

# Remove known AI artifact files from a project directory (untracked leftovers).
ai_remove_ai_artifact_files() {
    local project_dir="$1"
    local name

    [[ -n "$project_dir" && -d "$project_dir" ]] || return 0

    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        rm -f "${project_dir}/${name}"
    done < <(ai_implement_notes_basenames)
}

# Unstage known AI artifact paths if they were accidentally staged.
ai_unstage_ai_artifact_files() {
    local project_dir="$1"
    local name
    local paths=()

    [[ -n "$project_dir" && -d "$project_dir" ]] || return 0

    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        if git -C "$project_dir" ls-files --cached --error-unmatch "$name" >/dev/null 2>&1; then
            paths+=("$name")
        fi
    done < <(ai_implement_notes_basenames)

    if [[ "${#paths[@]}" -gt 0 ]]; then
        git -C "$project_dir" reset HEAD -- "${paths[@]}" >/dev/null 2>&1 || true
        for name in "${paths[@]}"; do
            rm -f "${project_dir}/${name}"
        done
        echo "Unstaged AI artifact file(s): ${paths[*]}" >&2
    fi
}

# Wrap saved notes Markdown with a short automation footer for posting.
# Prints the full comment body to stdout.
ai_format_implement_notes_comment() {
    local notes_path="$1"
    local kind="${2:-pull request}"

    cat "$notes_path"
    cat <<EOF

---
_These notes were posted automatically after the AI implementation run. They are not part of the ${kind} description — use them for merge/deploy checklist items (env, migrations, verification)._
EOF
}

# Post implement notes as a GitHub PR comment.
# Usage: ai_post_github_pr_notes <repo> <pr_ref> <notes_path>
# Echoes comment URL on success. Returns non-zero on failure.
ai_post_github_pr_notes() {
    local repo="$1"
    local pr_ref="$2"
    local notes_path="$3"
    local comment_file comment_url

    if [[ ! -f "$notes_path" ]]; then
        echo "WARNING: Skipping GitHub notes comment (file missing)." >&2
        return 1
    fi

    comment_file="$(mktemp)"
    ai_format_implement_notes_comment "$notes_path" "pull request" > "$comment_file"

    echo "Posting implement notes comment to GitHub PR $pr_ref..." >&2
    comment_url="$(
        gh pr comment "$pr_ref" \
            --repo "$repo" \
            --body-file "$comment_file"
    )"
    rm -f "$comment_file"

    if [[ -z "$comment_url" ]]; then
        echo "WARNING: Could not verify GitHub notes comment creation." >&2
        return 1
    fi

    echo "Notes comment posted: $comment_url" >&2
    printf '%s\n' "$comment_url"
    return 0
}

# Post implement notes as a GitLab MR note.
# Usage: ai_post_gitlab_mr_notes <project_path> <mr_iid> <notes_path>
# Requires gitlab.sh sourced. Echoes note URL/id on success.
ai_post_gitlab_mr_notes() {
    local project_path="$1"
    local mr_iid="$2"
    local notes_path="$3"
    local comment_body note_json note_id note_url

    if [[ ! -f "$notes_path" ]]; then
        echo "WARNING: Skipping GitLab notes comment (file missing)." >&2
        return 1
    fi

    if ! declare -F gitlab_create_mr_note >/dev/null 2>&1; then
        echo "WARNING: gitlab_create_mr_note unavailable; cannot post notes." >&2
        return 1
    fi

    comment_body="$(ai_format_implement_notes_comment "$notes_path" "merge request")"

    echo "Posting implement notes comment to GitLab MR !$mr_iid..." >&2
    note_json="$(gitlab_create_mr_note "$project_path" "$mr_iid" "$comment_body")"
    note_id="$(jq -r '.id // empty' <<<"$note_json")"

    if [[ -z "$note_id" ]]; then
        echo "WARNING: Could not verify GitLab notes comment creation." >&2
        echo "$note_json" >&2
        return 1
    fi

    note_url="$(jq -r '.web_url // empty' <<<"$note_json")"
    echo "Notes comment posted (note id: $note_id)" >&2
    if [[ -n "$note_url" ]]; then
        echo "Notes comment URL: $note_url" >&2
        printf '%s\n' "$note_url"
    else
        printf '%s\n' "$note_id"
    fi
    return 0
}
