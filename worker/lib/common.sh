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
# Fields: name, path, block_on_open_pr (bool; default true).
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
            forge: (.forge // "" | tostring)
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

# Ask the platform to clone a managed workspace if missing.
# Usage: ai_ensure_project_workspace <project_dir> <project_name> [forge] [full_name]
# Returns:
#   0 — workspace ready
#   2 — clone queued/in progress (caller should skip this cycle; fair to other repos)
#   1 — hard failure
# Non-blocking by default so one large clone never stalls polling for every other repo.
# Set AI_ENSURE_WAIT_SECONDS>0 to wait briefly (optional).
# Requires WEB_INTERNAL_URL + WORKER_INTERNAL_TOKEN (set by platform-wrapper).
ai_ensure_project_workspace() {
    local project_dir="$1"
    local project_name="$2"
    local forge="${3:-}"
    local full_name="${4:-}"
    local web_url token payload status body
    local wait_seconds="${AI_ENSURE_WAIT_SECONDS:-0}"
    local attempt max_attempts sleep_s=5

    if ai_validate_project_dir "$project_name" "$project_dir" 1; then
        return 0
    fi

    web_url="${WEB_INTERNAL_URL:-}"
    token="${WORKER_INTERNAL_TOKEN:-}"
    if [[ -z "$web_url" || -z "$token" ]]; then
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

        if [[ "$status" == "ready" ]] || ai_validate_project_dir "$project_name" "$project_dir" 1; then
            if ai_validate_project_dir "$project_name" "$project_dir" 1; then
                echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Workspace ready for $project_name"
                return 0
            fi
        fi

        if [[ "$status" == "failed" || "$status" == "inaccessible" ]]; then
            echo "ERROR: Workspace ensure failed for $project_name (status=$status)" >&2
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
            body: .body // "",
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
                body: .body // "",
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
                    body: .body // ""
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
    grep -qiE '^##[[:space:]]+Why this was not implemented' "$notes_file"
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
