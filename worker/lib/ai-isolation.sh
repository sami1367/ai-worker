#!/usr/bin/env bash
# Technical isolation between AI agent processes and privileged forge/Git ops.
# Sourced by lib/ai.sh. Do not execute directly.
#
# Phase A (agent): sanitized env + optional bubblewrap filesystem overlays.
# Phase B (orchestration): parent shell retains forge tokens and performs
# commit / push / PR-MR / comments. Credentials are never restored into the agent.

# Isolation mode:
#   auto  — bubblewrap when available, else env scrub only (default)
#   bwrap — require bubblewrap (fail if missing)
#   env   — environment scrub only (no filesystem overlays)
#   off   — disabled (insecure; operators only)
AI_ISOLATION_MODE="${AI_ISOLATION_MODE:-auto}"

# Empty file used to mask secret paths inside the sandbox.
AI_ISOLATION_EMPTY_FILE="${AI_ISOLATION_EMPTY_FILE:-}"

# Privileged env vars that must never reach the agent process.
# Keep CURSOR_API_KEY / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
# OPENAI_API_KEY / CODEX_API_KEY / GEMINI_API_KEY / COPILOT_GITHUB_TOKEN —
# those are required for the AI CLIs and are not forge publishing credentials.
# (Copilot must use COPILOT_GITHUB_TOKEN, not GH_TOKEN/GITHUB_TOKEN.)
AI_ISOLATION_STRIP_VARS=(
    GH_TOKEN
    GITHUB_TOKEN
    GH_ENTERPRISE_TOKEN
    GH_HOST
    GH_PROMPT_DISABLED
    GITLAB_TOKEN
    GITLAB_PRIVATE_TOKEN
    GITLAB_HOST
    GIT_SSH_COMMAND
    SSH_AUTH_SOCK
    SSH_AGENT_PID
    DATABASE_URL
    POSTGRES_PASSWORD
    POSTGRES_USER
    POSTGRES_DB
    NUXT_SESSION_PASSWORD
    SECRET_ENCRYPTION_KEY
    WORKER_INTERNAL_TOKEN
    INITIAL_ADMIN_BOOTSTRAP_SECRET
    INITIAL_ADMIN_USERNAME
    INITIAL_ADMIN_PASSWORD
)

# Probe whether bubblewrap can create the namespaces it needs.
# Docker AppArmor/seccomp (and some host kernels) install `bwrap` but block
# CLONE_NEWUSER — selecting bwrap then aborts every agent at start.
# Cached per process so we only pay the cost once per worker shell.
AI_ISOLATION_BWRAP_USABLE=""

ai_isolation_bwrap_usable() {
    if [[ -n "${AI_ISOLATION_BWRAP_USABLE:-}" ]]; then
        [[ "$AI_ISOLATION_BWRAP_USABLE" == "1" ]]
        return $?
    fi
    if ! command -v bwrap >/dev/null 2>&1; then
        AI_ISOLATION_BWRAP_USABLE=0
        return 1
    fi
    # Minimal probe: same namespace path as a real agent sandbox.
    if bwrap --ro-bind / / --dev /dev --proc /proc --die-with-parent -- true >/dev/null 2>&1; then
        AI_ISOLATION_BWRAP_USABLE=1
        return 0
    fi
    AI_ISOLATION_BWRAP_USABLE=0
    return 1
}

# Resolve whether bubblewrap should be used for this run.
# Prints: bwrap | env | off
ai_isolation_resolved_mode() {
    local mode="${AI_ISOLATION_MODE:-auto}"
    case "$mode" in
        off | env)
            printf '%s\n' "$mode"
            ;;
        bwrap)
            if ! command -v bwrap >/dev/null 2>&1; then
                echo "ERROR: AI_ISOLATION_MODE=bwrap but bubblewrap (bwrap) is not installed." >&2
                return 1
            fi
            if ! ai_isolation_bwrap_usable; then
                echo "ERROR: AI_ISOLATION_MODE=bwrap but bubblewrap cannot create user namespaces." >&2
                echo "HINT: On Ubuntu Docker, recreate the worker with security_opt apparmor/seccomp unconfined" >&2
                echo "      (see docker-compose.yml worker service), or set AI_ISOLATION_MODE=env." >&2
                return 1
            fi
            printf '%s\n' "bwrap"
            ;;
        auto | *)
            if ai_isolation_bwrap_usable; then
                printf '%s\n' "bwrap"
            else
                if command -v bwrap >/dev/null 2>&1; then
                    echo "WARNING: bubblewrap is installed but cannot create namespaces; falling back to AI isolation mode=env." >&2
                fi
                printf '%s\n' "env"
            fi
            ;;
    esac
}

ai_isolation_ensure_empty_file() {
    if [[ -n "${AI_ISOLATION_EMPTY_FILE:-}" && -f "$AI_ISOLATION_EMPTY_FILE" ]]; then
        return 0
    fi
    AI_ISOLATION_EMPTY_FILE="$(mktemp "${TMPDIR:-/tmp}/ai-isolation-empty.XXXXXX")"
    : >"$AI_ISOLATION_EMPTY_FILE"
    chmod 444 "$AI_ISOLATION_EMPTY_FILE" 2>/dev/null || true
}

# Collect absolute paths that must be unreadable/empty inside the agent sandbox.
ai_isolation_secret_paths() {
    local base="${AI_WORKER_BASE_DIR:-${BASE_DIR:-}}"
    local -a paths=()

    if [[ -n "$base" ]]; then
        paths+=(
            "$base/forge-credentials.env"
            "$base/provider-credentials.env"
            "$base/app-secrets.env"
            "$base/.env"
        )
    fi

    # Docker layout mirrors (when BASE_DIR differs from volume root).
    paths+=(
        /data/config/forge-credentials.env
        /data/config/provider-credentials.env
        /data/config/app-secrets.env
        /data/config/.env
    )

    if [[ -n "${HOME:-}" ]]; then
        paths+=(
            "$HOME/.git-credentials"
            "$HOME/.config/gh/hosts.yml"
        )
    fi

    local p
    for p in "${paths[@]}"; do
        [[ -e "$p" || -L "$p" ]] || continue
        printf '%s\n' "$p"
    done | awk 'NF && !seen[$0]++'
}

# Directories overlaid with tmpfs so existing keys/tokens are invisible.
ai_isolation_secret_dirs() {
    local base="${AI_WORKER_BASE_DIR:-${BASE_DIR:-}}"
    local -a dirs=()

    if [[ -n "$base" ]]; then
        dirs+=("$base/ssh")
    fi
    dirs+=(/data/config/ssh)

    if [[ -n "${HOME:-}" ]]; then
        dirs+=(
            "$HOME/.ssh"
            "$HOME/.config/gh"
        )
    fi

    local d
    for d in "${dirs[@]}"; do
        [[ -d "$d" ]] || continue
        printf '%s\n' "$d"
    done | awk 'NF && !seen[$0]++'
}

# Build env argv prefix: `env -u VAR ... GIT_CONFIG_*=...`
# Fills global AI_ISOLATION_ENV_PREFIX array.
AI_ISOLATION_ENV_PREFIX=()

ai_isolation_build_env_prefix() {
    local var
    local gitlab_host="${GITLAB_HOST:-}"
    local config_count=4

    AI_ISOLATION_ENV_PREFIX=(env)

    for var in "${AI_ISOLATION_STRIP_VARS[@]}"; do
        AI_ISOLATION_ENV_PREFIX+=(-u "$var")
    done

    if [[ -n "$gitlab_host" ]]; then
        gitlab_host="${gitlab_host#https://}"
        gitlab_host="${gitlab_host#http://}"
        gitlab_host="${gitlab_host%%/*}"
        if [[ -n "$gitlab_host" && "$gitlab_host" != "gitlab.com" ]]; then
            config_count=5
        fi
    fi

    AI_ISOLATION_ENV_PREFIX+=(
        GIT_TERMINAL_PROMPT=0
        GIT_ASKPASS=/bin/false
        "GIT_CONFIG_COUNT=${config_count}"
        GIT_CONFIG_KEY_0=credential.helper
        GIT_CONFIG_VALUE_0=
        GIT_CONFIG_KEY_1=core.askPass
        GIT_CONFIG_VALUE_1=/bin/false
        GIT_CONFIG_KEY_2=credential.https://github.com.helper
        GIT_CONFIG_VALUE_2=
        GIT_CONFIG_KEY_3=credential.https://gitlab.com.helper
        GIT_CONFIG_VALUE_3=
    )

    if [[ "$config_count" -eq 5 ]]; then
        AI_ISOLATION_ENV_PREFIX+=(
            "GIT_CONFIG_KEY_4=credential.https://${gitlab_host}.helper"
            GIT_CONFIG_VALUE_4=
        )
    fi
}

# Run a command as the AI agent under isolation.
# Usage: ai_isolation_exec <workspace> -- <command> [args...]
ai_isolation_exec() {
    local workspace="$1"
    shift

    if [[ "${1:-}" != "--" ]]; then
        echo "ERROR: ai_isolation_exec usage: ai_isolation_exec <workspace> -- <command>..." >&2
        return 2
    fi
    shift

    if [[ -z "$workspace" || ! -d "$workspace" ]]; then
        echo "ERROR: ai_isolation_exec: workspace is not a directory: $workspace" >&2
        return 2
    fi

    # Canonicalize for bind mounts.
    workspace="$(cd "$workspace" && pwd)"

    local mode
    mode="$(ai_isolation_resolved_mode)" || return 1

    if [[ "$mode" == "off" ]]; then
        echo "WARNING: AI agent isolation is OFF (AI_ISOLATION_MODE=off)." >&2
        "$@"
        return $?
    fi

    ai_isolation_build_env_prefix

    if [[ "$mode" != "bwrap" ]]; then
        echo "AI isolation: mode=env"
        "${AI_ISOLATION_ENV_PREFIX[@]}" "$@"
        return $?
    fi

    ai_isolation_ensure_empty_file

    local -a bwrap_args=(
        bwrap
        --bind / /
        --dev /dev
        --proc /proc
        --die-with-parent
    )

    # Confine writes under the workspaces root to the assigned workspace only.
    local ws_root="${WORKSPACE_ROOT:-/data/workspaces}"
    local confine_ws=0
    if [[ -d "$ws_root" ]]; then
        ws_root="$(cd "$ws_root" && pwd)"
        case "$workspace" in
            "$ws_root"/*)
                confine_ws=1
                bwrap_args+=(--ro-bind "$ws_root" "$ws_root")
                ;;
        esac
    fi

    # Config / logs / state: read-only for the agent (orchestration writes outside).
    local base="${AI_WORKER_BASE_DIR:-${BASE_DIR:-}}"
    if [[ -n "$base" && -d "$base" ]]; then
        base="$(cd "$base" && pwd)"
        # Avoid making the assigned workspace read-only when it lives under BASE_DIR
        # (some host installs colocate trees). Workspace is re-bound RW below.
        bwrap_args+=(--ro-bind "$base" "$base")
    fi
    if [[ -d /data/config && ( -z "$base" || "$base" != "/data/config" ) ]]; then
        bwrap_args+=(--ro-bind /data/config /data/config)
    fi
    if [[ -d /data/logs ]]; then
        bwrap_args+=(--ro-bind /data/logs /data/logs)
    fi
    if [[ -d /data/state ]]; then
        bwrap_args+=(--ro-bind /data/state /data/state)
    fi

    local secret_path secret_dir
    while IFS= read -r secret_path; do
        [[ -n "$secret_path" ]] || continue
        bwrap_args+=(--ro-bind "$AI_ISOLATION_EMPTY_FILE" "$secret_path")
    done < <(ai_isolation_secret_paths)

    while IFS= read -r secret_dir; do
        [[ -n "$secret_dir" ]] || continue
        bwrap_args+=(--tmpfs "$secret_dir")
    done < <(ai_isolation_secret_dirs)

    # Workspace must be writable and must win over any earlier ro-bind of a parent.
    bwrap_args+=(--bind "$workspace" "$workspace")
    if [[ "$confine_ws" -eq 1 ]]; then
        : # sibling workspaces remain read-only via ws_root ro-bind above
    fi

    # Strip privileged vars inside the sandbox as well (defense in depth).
    local var
    for var in "${AI_ISOLATION_STRIP_VARS[@]}"; do
        bwrap_args+=(--unsetenv "$var")
    done

    echo "AI isolation: mode=bwrap workspace=$workspace"
    "${bwrap_args[@]}" -- "${AI_ISOLATION_ENV_PREFIX[@]}" "$@"
    return $?
}

# ----- Phase logging (never logs secret values) -----

ai_log_phase() {
    local phase="$1"
    local detail="${2:-}"
    if declare -F ai_log_banner >/dev/null 2>&1; then
        ai_log_banner "PHASE: ${phase}"
    else
        echo
        echo "============================================================"
        echo "                    PHASE: ${phase}"
        echo "============================================================"
    fi
    echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    if [[ -n "$detail" ]]; then
        echo "$detail"
    fi
    case "$phase" in
        AGENT)
            local mode
            mode="$(ai_isolation_resolved_mode 2>/dev/null || echo unknown)"
            echo "Isolation mode: $mode"
            echo "Forge credentials: not available to agent"
            ;;
        VALIDATE)
            echo "Validating agent output with trusted orchestration policy"
            ;;
        PUBLISH)
            echo "Publishing via trusted orchestration (commit/push/PR-MR/comments)"
            ;;
    esac
    echo "============================================================"
}

# ----- Post-agent validation helpers -----

# Fail if the workspace has changes outside an allowlist of relative paths.
# Usage: ai_assert_only_allowed_changes <project_dir> <allowed_relpath> [more...]
# Exit 22 on unexpected modifications (same as existing no-change runners).
ai_assert_only_allowed_changes() {
    local project_dir="$1"
    shift
    local -A allowed=()
    local path rel dirty_lines line status_path

    if [[ -z "$project_dir" || ! -d "$project_dir" ]]; then
        echo "ERROR: ai_assert_only_allowed_changes: invalid project_dir" >&2
        return 2
    fi

    for path in "$@"; do
        # Normalize to repo-relative basenames and full relative paths.
        rel="${path#"$project_dir"/}"
        allowed["$rel"]=1
        allowed["${rel##*/}"]=1
    done

    dirty_lines="$(git -C "$project_dir" status --porcelain 2>/dev/null || true)"
    [[ -z "$dirty_lines" ]] && return 0

    local unexpected=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -z "$line" ]] && continue
        # porcelain: XY PATH or XY ORIG -> PATH
        status_path="${line:3}"
        if [[ "$status_path" == *" -> "* ]]; then
            status_path="${status_path##* -> }"
        fi
        # Strip optional quotes from git status -z-less porcelain.
        status_path="${status_path#\"}"
        status_path="${status_path%\"}"

        if [[ -n "${allowed[$status_path]:-}" || -n "${allowed[${status_path##*/}]:-}" ]]; then
            continue
        fi
        if [[ "$unexpected" -eq 0 ]]; then
            echo
            echo "ERROR: Agent modified files outside the allowed artifact set:"
        fi
        printf '%s\n' "$line"
        unexpected=1
    done <<<"$dirty_lines"

    if [[ "$unexpected" -ne 0 ]]; then
        return 22
    fi
    return 0
}

# Validate a file that will be posted to a forge (PR/MR body, comment).
# Rejects missing/empty (optional), embedded NULs, and oversize payloads.
# On success, optionally writes a size-capped copy to <out_file>.
# Usage: ai_validate_forge_text_file <in_file> [max_bytes=200000] [allow_empty=0] [out_file]
ai_validate_forge_text_file() {
    local in_file="$1"
    local max_bytes="${2:-200000}"
    local allow_empty="${3:-0}"
    local out_file="${4:-}"
    local bytes stripped

    if [[ -z "$in_file" || ! -f "$in_file" ]]; then
        echo "ERROR: Forge text file missing: ${in_file:-}" >&2
        return 1
    fi

    bytes="$(wc -c <"$in_file" | tr -d ' ')"
    stripped="$(tr -d '\0' <"$in_file" | wc -c | tr -d ' ')"
    if [[ "$bytes" -ne "$stripped" ]]; then
        echo "ERROR: Forge text contains NUL bytes; refusing to publish." >&2
        return 1
    fi

    if [[ "$bytes" -eq 0 && "$allow_empty" != "1" ]]; then
        echo "ERROR: Forge text is empty; refusing to publish." >&2
        return 1
    fi

    if [[ -n "$out_file" ]]; then
        if [[ "$bytes" -gt "$max_bytes" ]]; then
            echo "WARNING: Forge text truncated from $bytes to $max_bytes bytes." >&2
            {
                head -c "$max_bytes" "$in_file"
                printf '\n\n_…truncated by AI Worker orchestration…_\n'
            } >"$out_file"
        else
            cp "$in_file" "$out_file"
        fi
    elif [[ "$bytes" -gt "$max_bytes" ]]; then
        echo "ERROR: Forge text exceeds $max_bytes bytes; refusing to publish." >&2
        return 1
    fi

    return 0
}

# Ensure a path stays inside a trusted root (no traversal).
# Usage: ai_path_inside_root <root> <path>
ai_path_inside_root() {
    local root="$1"
    local path="$2"
    local root_abs path_abs

    [[ -n "$root" && -n "$path" ]] || return 1
    root_abs="$(cd "$root" && pwd)" || return 1

    if [[ -d "$path" ]]; then
        path_abs="$(cd "$path" && pwd)" || return 1
    elif [[ -e "$path" ]]; then
        path_abs="$(cd "$(dirname "$path")" && pwd)/$(basename "$path")" || return 1
    else
        # Non-existent path: resolve parent.
        local parent
        parent="$(dirname "$path")"
        [[ -d "$parent" ]] || return 1
        path_abs="$(cd "$parent" && pwd)/$(basename "$path")" || return 1
    fi

    case "$path_abs" in
        "$root_abs" | "$root_abs"/*) return 0 ;;
        *) return 1 ;;
    esac
}
