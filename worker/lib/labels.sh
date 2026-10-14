#!/usr/bin/env bash
# AI worker forge labels — keep in sync with server/services/ai-labels-def.ts
# Source after lib/common.sh (needs jq/curl helpers for API path).

: "${WORKER_CODE_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Session cache so we only ensure once per forge:project per worker process.
AI_LABELS_ENSURED_CACHE="${AI_LABELS_ENSURED_CACHE:-}"

# Prints TSV lines: name<TAB>color<TAB>description
ai_worker_label_specs() {
    cat <<'EOF'
ai	0E8A16	Queue this issue for the AI worker
ai-working	FBCA04	AI worker is currently processing this issue
ai-pr	1D76DB	AI worker opened a pull request / merge request
ai-failed	D73A4A	AI worker failed; review logs before retrying
no-change	BFDADC	With ai: answer in issue comments only (no code changes or PR/MR)
ai-answered	0E8A16	AI answered a no-change question in issue comments
ai-review	7057FF	Queue this open pull request / merge request for an AI review comment
ai-reviewing	FBCA04	AI worker is currently reviewing this pull request / merge request
ai-reviewed	0E8A16	AI review comment was posted on this pull request / merge request
ai-review-failed	D73A4A	AI PR/MR review failed; review logs before retrying
EOF
}

ai_labels_cache_has() {
    local key="$1"
    [[ " ${AI_LABELS_ENSURED_CACHE} " == *" ${key} "* ]]
}

ai_labels_cache_add() {
    local key="$1"
    AI_LABELS_ENSURED_CACHE="${AI_LABELS_ENSURED_CACHE} ${key}"
}

# Create missing labels on GitHub via gh (idempotent).
# Usage: ai_ensure_github_labels_local <owner/repo>
ai_ensure_github_labels_local() {
    local repo="$1"
    local name color description

    if [[ -z "$repo" ]]; then
        echo "ERROR: ai_ensure_github_labels_local requires owner/repo" >&2
        return 1
    fi
    if ! command -v gh >/dev/null 2>&1; then
        echo "ERROR: gh is required to create GitHub labels" >&2
        return 1
    fi

    while IFS=$'\t' read -r name color description; do
        [[ -n "$name" ]] || continue
        gh label create "$name" \
            --repo "$repo" \
            --color "$color" \
            --description "$description" \
            --force >/dev/null 2>&1 || true
    done < <(ai_worker_label_specs)
    return 0
}

# Create missing labels on GitLab via API (idempotent).
# Usage: ai_ensure_gitlab_labels_local <project_path>
ai_ensure_gitlab_labels_local() {
    local project_path="$1"
    local name color description

    if [[ -z "$project_path" ]]; then
        echo "ERROR: ai_ensure_gitlab_labels_local requires project path" >&2
        return 1
    fi
    if ! declare -F gitlab_create_label >/dev/null 2>&1; then
        echo "ERROR: gitlab_create_label unavailable; source lib/gitlab.sh first" >&2
        return 1
    fi

    while IFS=$'\t' read -r name color description; do
        [[ -n "$name" ]] || continue
        gitlab_create_label "$project_path" "$name" "$color" "$description" \
            >/dev/null 2>&1 || true
    done < <(ai_worker_label_specs)
    return 0
}

# Prefer control-plane API (uses connection tokens + AI_WORKER_LABELS).
# Falls back to local gh / GitLab API when WEB_INTERNAL_URL is unset.
# Usage: ai_ensure_project_labels <github|gitlab> <full_name> [project_name]
# Always returns 0 (best-effort); prints a warning on soft failure.
ai_ensure_project_labels() {
    local forge="$1"
    local full_name="$2"
    local project_name="${3:-}"
    local cache_key web_url token payload body created existing ok

    if [[ -z "$forge" || -z "$full_name" ]]; then
        echo "WARNING: ai_ensure_project_labels requires forge and full_name" >&2
        return 0
    fi

    case "$forge" in
        github | gitlab) ;;
        *)
            echo "WARNING: ai_ensure_project_labels unknown forge: $forge" >&2
            return 0
            ;;
    esac

    cache_key="${forge}:${full_name}"
    if ai_labels_cache_has "$cache_key"; then
        return 0
    fi

    web_url="${WEB_INTERNAL_URL:-}"
    token="${WORKER_INTERNAL_TOKEN:-}"

    if [[ -n "$web_url" && -n "$token" ]] && command -v jq >/dev/null 2>&1; then
        payload="$(jq -n \
            --arg forge "$forge" \
            --arg full "$full_name" \
            --arg name "$project_name" \
            '{
                forgeType: $forge,
                fullName: $full
            }
            + (if $name == "" then {} else {name: $name} end)')"

        body="$(
            curl -fsS -X POST \
                -H "Content-Type: application/json" \
                -H "Accept: application/json" \
                -H "x-worker-token: $token" \
                -d "$payload" \
                "${web_url}/api/v1/worker/internal/ensure-labels" 2>/dev/null || true
        )"

        if [[ -n "$body" ]]; then
            ok="$(jq -r '.ok // false' <<<"$body" 2>/dev/null || echo false)"
            if [[ "$ok" == "true" ]]; then
                created="$(jq -r '.created // 0' <<<"$body" 2>/dev/null || echo 0)"
                existing="$(jq -r '.existing // 0' <<<"$body" 2>/dev/null || echo 0)"
                if [[ "$created" != "0" ]]; then
                    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Ensured forge labels on ${forge}:${full_name} (created=${created}, existing=${existing})"
                fi
                ai_labels_cache_add "$cache_key"
                return 0
            fi
        fi
        echo "WARNING: ensure-labels API failed for ${forge}:${full_name}; trying local fallback" >&2
    fi

    if [[ "$forge" == "github" ]]; then
        if ai_ensure_github_labels_local "$full_name"; then
            ai_labels_cache_add "$cache_key"
            return 0
        fi
    else
        if ai_ensure_gitlab_labels_local "$full_name"; then
            ai_labels_cache_add "$cache_key"
            return 0
        fi
    fi

    echo "WARNING: Could not ensure AI labels on ${forge}:${full_name}" >&2
    return 0
}
