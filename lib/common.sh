#!/usr/bin/env bash
# Shared helpers for the AI worker. Source from other scripts; do not execute.

# Resolve BASE_DIR from the sourcing script when not already set.
: "${BASE_DIR:=/home/ubuntu/ai-worker}"

ai_load_env() {
    local env_file="${1:-$BASE_DIR/.env}"

    if [[ -f "$env_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$env_file"
        set +a
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
    source "$BASE_DIR/lib/ai/cursor.sh"
    ai_cursor_detect
}

# Resolve project path from a conf file: name=path
ai_resolve_project_dir() {
    local projects_file="$1"
    local project="$2"

    if [[ ! -f "$projects_file" ]]; then
        echo "ERROR: Projects file not found: $projects_file" >&2
        return 1
    fi

    awk -F= -v project="$project" '
        /^[[:space:]]*#/ { next }
        NF >= 2 && $1 == project {
            sub(/^[^=]*=/, "")
            gsub(/\r$/, "")
            print
            exit
        }
    ' "$projects_file"
}

# Validate a project directory is a usable git repo.
# Usage: ai_validate_project_dir <project_name> <project_dir>
ai_validate_project_dir() {
    local project="$1"
    local project_dir="$2"

    if [[ -z "$project_dir" ]]; then
        echo "WARNING: Empty project path for: $project"
        return 1
    fi

    if [[ ! -d "$project_dir" ]]; then
        echo "WARNING: Project directory does not exist: $project_dir"
        return 1
    fi

    if ! git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "WARNING: Not a Git repository: $project_dir"
        return 1
    fi

    return 0
}

# Iterate conf lines. Calls callback as: callback <project> <project_dir>
# Skips blank lines and comments. Callback non-zero with FOUND_TASK=1 should
# signal the caller to stop (callback sets globals as needed).
ai_foreach_project() {
    local projects_file="$1"
    local callback="$2"
    local project project_dir

    if [[ ! -f "$projects_file" ]]; then
        return 0
    fi

    while IFS='=' read -r project project_dir || [[ -n "${project:-}" ]]; do
        project="${project%$'\r'}"
        project_dir="${project_dir%$'\r'}"

        [[ -z "$project" ]] && continue
        [[ "$project" =~ ^[[:space:]]*# ]] && continue

        if ! ai_validate_project_dir "$project" "$project_dir"; then
            continue
        fi

        if ! "$callback" "$project" "$project_dir"; then
            return 1
        fi
    done < "$projects_file"

    return 0
}

# Return 0 if staged/changed file list looks like secrets.
ai_has_secret_files() {
    local changed_files="$1"

    grep -Eq \
        '(^|/)\.env($|\.)|(^|/).*\.pem$|(^|/).*\.key$|(^|/)id_rsa$|(^|/)id_ed25519$' \
        <<<"$changed_files"
}

ai_log_banner() {
    local title="$1"
    echo
    echo "============================================================"
    echo "                    $title"
    echo "============================================================"
}
