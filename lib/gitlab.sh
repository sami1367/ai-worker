#!/usr/bin/env bash
# GitLab API helpers. Source after lib/common.sh.
# Requires: curl, jq, GITLAB_TOKEN, GITLAB_HOST (default git.dctm.dev)

: "${GITLAB_HOST:=git.dctm.dev}"

gitlab_api_base() {
    printf 'https://%s/api/v4' "$GITLAB_HOST"
}

gitlab_configured() {
    [[ -n "${GITLAB_TOKEN:-}" ]]
}

# URL-encode a project path (slashes -> %2F).
gitlab_encode_path() {
    local path="$1"
    path="${path#/}"
    path="${path%.git}"
    printf '%s' "$path" | sed 's|/|%2F|g'
}

# Extract GitLab project path from a git remote URL.
# Supports: git@host:group/proj.git  and  https://host/group/proj.git
gitlab_path_from_remote() {
    local url="$1"
    local path=""

    if [[ "$url" =~ ^git@[^:]+:(.+)$ ]]; then
        path="${BASH_REMATCH[1]}"
    elif [[ "$url" =~ ^https?://[^/]+/(.+)$ ]]; then
        path="${BASH_REMATCH[1]}"
    else
        return 1
    fi

    path="${path%.git}"
    path="${path#/}"
    printf '%s\n' "$path"
}

# Resolve GitLab project path from a local repo's origin remote.
gitlab_resolve_project_path() {
    local project_dir="$1"
    local url path

    url="$(git -C "$project_dir" remote get-url origin 2>/dev/null || true)"
    if [[ -z "$url" ]]; then
        return 1
    fi

    path="$(gitlab_path_from_remote "$url")" || return 1
    printf '%s\n' "$path"
}

# Low-level API call. Args: METHOD PATH [curl -d args...]
# Prints response body. Exit non-zero on HTTP >= 400.
gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2

    if ! gitlab_configured; then
        echo "ERROR: GITLAB_TOKEN is not set." >&2
        return 1
    fi

    local url http_code body tmp
    url="$(gitlab_api_base)${path}"
    tmp="$(mktemp)"

    http_code="$(
        curl -sS \
            -o "$tmp" \
            -w '%{http_code}' \
            -X "$method" \
            -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
            -H "Content-Type: application/json" \
            "$@" \
            "$url"
    )"

    body="$(cat "$tmp")"
    rm -f "$tmp"

    if [[ "$http_code" -ge 400 ]]; then
        echo "ERROR: GitLab API ${method} ${path} failed (HTTP ${http_code})" >&2
        echo "$body" >&2
        return 1
    fi

    printf '%s' "$body"
}

gitlab_get_issue() {
    local project_path="$1"
    local issue_iid="$2"
    local encoded

    encoded="$(gitlab_encode_path "$project_path")"
    gitlab_api GET "/projects/${encoded}/issues/${issue_iid}"
}

# Print oldest open issue iid with label "ai", or empty.
gitlab_find_ai_issue() {
    local project_path="$1"
    local encoded body iid

    encoded="$(gitlab_encode_path "$project_path")"
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/issues?labels=ai&state=opened&order_by=created_at&sort=asc&per_page=1"
    )" || return 1

    iid="$(jq -r '.[0].iid // empty' <<<"$body")"
    printf '%s' "$iid"
}

# Add and/or remove labels on an issue.
# Usage: gitlab_edit_issue_labels <project_path> <iid> [--add L] [--remove L] ...
gitlab_edit_issue_labels() {
    local project_path="$1"
    local issue_iid="$2"
    shift 2

    local add_labels="" remove_labels=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --add)
                if [[ -n "$add_labels" ]]; then
                    add_labels+=","
                fi
                add_labels+="$2"
                shift 2
                ;;
            --remove)
                if [[ -n "$remove_labels" ]]; then
                    remove_labels+=","
                fi
                remove_labels+="$2"
                shift 2
                ;;
            *)
                echo "ERROR: Unknown argument to gitlab_edit_issue_labels: $1" >&2
                return 1
                ;;
        esac
    done

    local encoded payload
    encoded="$(gitlab_encode_path "$project_path")"

    if [[ -z "$add_labels" && -z "$remove_labels" ]]; then
        return 0
    fi

    payload="$(
        jq -n \
            --arg add "$add_labels" \
            --arg remove "$remove_labels" \
            '
            (if $add == "" then {} else {add_labels: $add} end)
            +
            (if $remove == "" then {} else {remove_labels: $remove} end)
            '
    )"

    gitlab_api PUT "/projects/${encoded}/issues/${issue_iid}" \
        -d "$payload" >/dev/null
}

gitlab_create_label() {
    local project_path="$1"
    local name="$2"
    local color="$3"
    local description="$4"
    local encoded payload name_encoded http_code tmp

    encoded="$(gitlab_encode_path "$project_path")"
    name_encoded="$(printf '%s' "$name" | jq -sRr @uri)"
    payload="$(
        jq -n \
            --arg name "$name" \
            --arg color "#${color}" \
            --arg description "$description" \
            '{name: $name, color: $color, description: $description}'
    )"

    tmp="$(mktemp)"

    http_code="$(
        curl -sS \
            -o "$tmp" \
            -w '%{http_code}' \
            -X POST \
            -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$payload" \
            "$(gitlab_api_base)/projects/${encoded}/labels"
    )"

    # Already exists (or other client error): update in place.
    if [[ "$http_code" -eq 400 || "$http_code" -eq 409 ]]; then
        curl -sS \
            -o "$tmp" \
            -X PUT \
            -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$payload" \
            "$(gitlab_api_base)/projects/${encoded}/labels/${name_encoded}" \
            >/dev/null || true
    elif [[ "$http_code" -ge 400 ]]; then
        echo "ERROR: Failed to create label '$name' (HTTP ${http_code})" >&2
        cat "$tmp" >&2
        rm -f "$tmp"
        return 1
    fi

    rm -f "$tmp"
}

gitlab_create_mr() {
    local project_path="$1"
    local source_branch="$2"
    local target_branch="$3"
    local title="$4"
    local description="$5"
    local encoded payload

    encoded="$(gitlab_encode_path "$project_path")"
    payload="$(
        jq -n \
            --arg source "$source_branch" \
            --arg target "$target_branch" \
            --arg title "$title" \
            --arg description "$description" \
            '{
                source_branch: $source,
                target_branch: $target,
                title: $title,
                description: $description,
                remove_source_branch: false
            }'
    )"

    gitlab_api POST "/projects/${encoded}/merge_requests" -d "$payload"
}

# Post a note/comment on an issue (optional helper).
gitlab_create_issue_note() {
    local project_path="$1"
    local issue_iid="$2"
    local body="$3"
    local encoded payload

    encoded="$(gitlab_encode_path "$project_path")"
    payload="$(jq -n --arg body "$body" '{body: $body}')"
    gitlab_api POST "/projects/${encoded}/issues/${issue_iid}/notes" -d "$payload"
}

gitlab_get_mr() {
    local project_path="$1"
    local mr_iid="$2"
    local encoded

    encoded="$(gitlab_encode_path "$project_path")"
    gitlab_api GET "/projects/${encoded}/merge_requests/${mr_iid}"
}

# Print oldest open MR iid with label "ai-review", or empty.
gitlab_find_ai_review_mr() {
    local project_path="$1"
    local encoded body iid

    encoded="$(gitlab_encode_path "$project_path")"
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/merge_requests?labels=ai-review&state=opened&order_by=created_at&sort=asc&per_page=1"
    )" || return 1

    iid="$(jq -r '.[0].iid // empty' <<<"$body")"
    printf '%s' "$iid"
}

# MR diffs/changes payload (includes diffs array).
gitlab_get_mr_changes() {
    local project_path="$1"
    local mr_iid="$2"
    local encoded

    encoded="$(gitlab_encode_path "$project_path")"
    gitlab_api GET "/projects/${encoded}/merge_requests/${mr_iid}/changes"
}

# Add and/or remove labels on a merge request.
# Usage: gitlab_edit_mr_labels <project_path> <iid> [--add L] [--remove L] ...
gitlab_edit_mr_labels() {
    local project_path="$1"
    local mr_iid="$2"
    shift 2

    local add_labels="" remove_labels=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --add)
                if [[ -n "$add_labels" ]]; then
                    add_labels+=","
                fi
                add_labels+="$2"
                shift 2
                ;;
            --remove)
                if [[ -n "$remove_labels" ]]; then
                    remove_labels+=","
                fi
                remove_labels+="$2"
                shift 2
                ;;
            *)
                echo "ERROR: Unknown argument to gitlab_edit_mr_labels: $1" >&2
                return 1
                ;;
        esac
    done

    local encoded payload
    encoded="$(gitlab_encode_path "$project_path")"

    if [[ -z "$add_labels" && -z "$remove_labels" ]]; then
        return 0
    fi

    payload="$(
        jq -n \
            --arg add "$add_labels" \
            --arg remove "$remove_labels" \
            '
            (if $add == "" then {} else {add_labels: $add} end)
            +
            (if $remove == "" then {} else {remove_labels: $remove} end)
            '
    )"

    gitlab_api PUT "/projects/${encoded}/merge_requests/${mr_iid}" \
        -d "$payload" >/dev/null
}

# Post a note/comment on a merge request.
gitlab_create_mr_note() {
    local project_path="$1"
    local mr_iid="$2"
    local body="$3"
    local encoded payload

    encoded="$(gitlab_encode_path "$project_path")"
    payload="$(jq -n --arg body "$body" '{body: $body}')"
    gitlab_api POST "/projects/${encoded}/merge_requests/${mr_iid}/notes" -d "$payload"
}
