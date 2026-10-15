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

# Extract unique issue IIDs linked from MR title/description text.
# Recognizes GitLab-style refs, e.g.:
#   Closes #1
#   Fixes #123
#   Related to #45
#   Resolves #7
# Prints one IID per line (sorted, unique). Empty if none.
gitlab_extract_linked_issue_iids() {
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

# Print the authenticated GitLab user id, or fail.
gitlab_current_user_id() {
    local body id

    body="$(gitlab_api GET "/user")" || return 1
    id="$(jq -r '.id // empty' <<<"$body")"
    if [[ -z "$id" ]]; then
        return 1
    fi

    printf '%s' "$id"
}

# Print oldest open issue iid with the given label, or empty.
# Label-only: does not filter by assignee.
gitlab_find_open_issue_with_label() {
    local project_path="$1"
    local label="$2"
    local encoded body iid

    encoded="$(gitlab_encode_path "$project_path")"
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/issues?labels=${label}&state=opened&order_by=created_at&sort=asc&per_page=1"
    )" || return 1

    iid="$(jq -r '.[0].iid // empty' <<<"$body")"
    printf '%s' "$iid"
}

# Print oldest open issue iid with label "ai", or empty.
gitlab_find_ai_issue() {
    local project_path="$1"
    gitlab_find_open_issue_with_label "$project_path" "ai"
}

# Label open MRs whose source_branch is ai/issue-N or ai/issue-N-* with ai-pr.
# Usage: gitlab_label_open_issue_mrs_ai_pr <project_path> <issue_iid>
gitlab_label_open_issue_mrs_ai_pr() {
    local project_path="$1"
    local issue_iid="$2"
    local prefix="ai/issue-${issue_iid}"
    local encoded body mr_iid

    encoded="$(gitlab_encode_path "$project_path")"
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/merge_requests?state=opened&order_by=created_at&sort=desc&per_page=50"
    )" || return 0

    while IFS= read -r mr_iid; do
        [[ -n "$mr_iid" ]] || continue
        echo "Adding ai-pr label to merge request !$mr_iid"
        gitlab_edit_mr_labels "$project_path" "$mr_iid" --add "ai-pr" \
            >/dev/null 2>&1 || echo "WARNING: Could not add ai-pr to MR !$mr_iid"
    done < <(
        jq -r --arg p "$prefix" '
            .[]
            | select(
                .source_branch == $p
                or (.source_branch | startswith($p + "-"))
              )
            | .iid
        ' <<<"$body"
    )
}

# AI implement-workflow labels on an open MR that should block starting a new
# `ai` issue (human MRs without these labels / ai/issue-* sources do not block).
GITLAB_AI_IN_FLIGHT_MR_LABELS=(ai ai-working ai-failed ai-pr)

# Print a short description of the oldest open MR that should block a new issue,
# or empty. Prefers AI implement labels; falls back to source_branch ai/issue-*
# when labels were not applied. Example: "!12 (ai/issue-3, ai-pr)"
gitlab_find_open_mr() {
    local project_path="$1"
    local encoded label body
    local best_created="" best_desc=""
    local created desc

    encoded="$(gitlab_encode_path "$project_path")"
    for label in "${GITLAB_AI_IN_FLIGHT_MR_LABELS[@]}"; do
        body="$(
            gitlab_api GET \
                "/projects/${encoded}/merge_requests?labels=${label}&state=opened&order_by=created_at&sort=asc&per_page=1"
        )" || continue

        created="$(jq -r '.[0].created_at // empty' <<<"$body")"
        [[ -n "$created" ]] || continue

        desc="$(
            jq -r --arg label "$label" '
                .[0]
                | if . then "!\(.iid) (\(.source_branch // "unknown"), \($label))" else empty end
            ' <<<"$body"
        )"
        [[ -n "$desc" ]] || continue

        if [[ -z "$best_created" || "$created" < "$best_created" ]]; then
            best_created="$created"
            best_desc="$desc"
        fi
    done

    if [[ -n "$best_desc" ]]; then
        printf '%s' "$best_desc"
        return 0
    fi

    # Safety net: unlabeled AI branches still block (parity with GitHub).
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=50"
    )" || {
        printf '%s' ''
        return 0
    }

    jq -r '
        [
            .[]
            | select((.source_branch // "") | test("^ai/issue-[0-9]+(-|$)"))
        ]
        | .[0]
        | if . == null then empty
          else "!\(.iid) (\(.source_branch // "unknown"), ai-branch)"
          end
    ' <<<"$body" 2>/dev/null || true
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

    # Create any missing AI labels before mutating (runtime, not build-time only).
    if declare -F ai_ensure_project_labels >/dev/null 2>&1; then
        ai_ensure_project_labels gitlab "$project_path" || true
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

# Create a merge request. Optional 6th arg: comma-separated labels (e.g. ai-pr).
gitlab_create_mr() {
    local project_path="$1"
    local source_branch="$2"
    local target_branch="$3"
    local title="$4"
    local description="$5"
    local labels="${6:-}"
    local encoded payload

    if [[ -n "$labels" ]] && declare -F ai_ensure_project_labels >/dev/null 2>&1; then
        ai_ensure_project_labels gitlab "$project_path" || true
    fi

    encoded="$(gitlab_encode_path "$project_path")"
    payload="$(
        jq -n \
            --arg source "$source_branch" \
            --arg target "$target_branch" \
            --arg title "$title" \
            --arg description "$description" \
            --arg labels "$labels" \
            '{
                source_branch: $source,
                target_branch: $target,
                title: $title,
                description: $description,
                remove_source_branch: false
            }
            + (if $labels == "" then {} else {labels: $labels} end)'
    )"

    gitlab_api POST "/projects/${encoded}/merge_requests" -d "$payload"
}

# List notes on an issue (non-system, chronological). Prints JSON array.
gitlab_list_issue_notes() {
    local project_path="$1"
    local issue_iid="$2"
    local encoded page=1 page_body count combined="[]"

    encoded="$(gitlab_encode_path "$project_path")"

    while true; do
        page_body="$(
            gitlab_api GET \
                "/projects/${encoded}/issues/${issue_iid}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at"
        )" || return 1

        count="$(jq 'length' <<<"$page_body")"
        combined="$(jq -s 'add' <<<"$combined"$'\n'"$page_body")"

        if [[ "$count" -lt 100 ]]; then
            break
        fi
        page=$((page + 1))
    done

    jq '[.[] | select(.system != true)]' <<<"$combined"
}

# List notes on a merge request (non-system, chronological). Prints JSON array.
gitlab_list_mr_notes() {
    local project_path="$1"
    local mr_iid="$2"
    local encoded page=1 page_body count combined="[]"

    encoded="$(gitlab_encode_path "$project_path")"

    while true; do
        page_body="$(
            gitlab_api GET \
                "/projects/${encoded}/merge_requests/${mr_iid}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at"
        )" || return 1

        count="$(jq 'length' <<<"$page_body")"
        combined="$(jq -s 'add' <<<"$combined"$'\n'"$page_body")"

        if [[ "$count" -lt 100 ]]; then
            break
        fi
        page=$((page + 1))
    done

    jq '[.[] | select(.system != true)]' <<<"$combined"
}

# Map GitLab access_level to a review role label.
gitlab_access_level_to_role() {
    case "${1:-}" in
        50) printf 'owner' ;;
        40) printf 'maintainer' ;;
        30) printf 'developer' ;;
        20) printf 'reporter' ;;
        10) printf 'guest' ;;
        *) printf 'unknown' ;;
    esac
}

# Resolve a user's project role (owner/maintainer/developer/...). Empty on failure.
gitlab_get_user_project_role() {
    local project_path="$1"
    local user_id="$2"
    local encoded body access_level

    if [[ -z "$user_id" || "$user_id" == "null" ]]; then
        return 1
    fi

    encoded="$(gitlab_encode_path "$project_path")"
    body="$(
        gitlab_api GET "/projects/${encoded}/members/all/${user_id}" 2>/dev/null || true
    )"

    if [[ -z "$body" ]]; then
        return 1
    fi

    access_level="$(jq -r '.access_level // empty' <<<"$body")"
    if [[ -z "$access_level" ]]; then
        return 1
    fi

    gitlab_access_level_to_role "$access_level"
}

# Add .review_role to each note (lookup per unique author id).
gitlab_enrich_notes_with_roles() {
    local project_path="$1"
    local notes_json="$2"
    local user_id role role_map="{}"

    if [[ -z "$notes_json" || "$notes_json" == "[]" || "$notes_json" == "null" ]]; then
        printf '[]'
        return 0
    fi

    while IFS= read -r user_id; do
        [[ -z "$user_id" ]] && continue
        role="$(gitlab_get_user_project_role "$project_path" "$user_id" 2>/dev/null || true)"
        if [[ -n "$role" ]]; then
            role_map="$(jq -c --arg id "$user_id" --arg role "$role" '. + {($id): $role}' <<<"$role_map")"
        fi
    done < <(jq -r '.[].author.id // empty' <<<"$notes_json" | sort -u)

    local enriched
    if ! enriched="$(jq --argjson roles "$role_map" '
        map(
            . + {
                review_role: ($roles[.author.id | tostring] // "unknown")
            }
        )
    ' <<<"$notes_json")"; then
        echo "WARNING: Could not enrich GitLab notes with roles (jq failed); using raw notes." >&2
        printf '%s' "$notes_json"
        return 0
    fi

    if [[ -z "$enriched" ]]; then
        printf '%s' "$notes_json"
        return 0
    fi

    printf '%s' "$enriched"
}

# Format GitLab notes JSON into readable chronological text.
gitlab_format_notes() {
    local notes_json="$1"
    local max_bytes="${2:-30000}"
    local project_path="${3:-}"

    if [[ -n "$project_path" ]]; then
        notes_json="$(gitlab_enrich_notes_with_roles "$project_path" "$notes_json")"
    fi

    if [[ -z "$notes_json" || "$notes_json" == "[]" || "$notes_json" == "null" ]]; then
        printf '%s' "(no comments)"
        return 0
    fi

    ai_trim_text "$(
        jq -r '
            if length == 0 then "(no comments)"
            else map(
                if (.review_role? // "") != "" and .review_role != "unknown" then
                    "--- Comment by \(.author.username // .author.name // "unknown") (\(.review_role)) at \(.created_at) ---\n\(.body // "")\n"
                else
                    "--- Comment by \(.author.username // .author.name // "unknown") at \(.created_at) ---\n\(.body // "")\n"
                end
            ) | join("\n")
            end
        ' <<<"$notes_json"
    )" "$max_bytes"
}

# Create an issue with the given label (default ai). Prints the issue JSON.
# Usage: gitlab_create_issue <project_path> <title> <description> [label]
gitlab_create_issue() {
    local project_path="$1"
    local title="$2"
    local description="$3"
    local label="${4:-ai}"
    local encoded payload

    if declare -F ai_ensure_project_labels >/dev/null 2>&1; then
        ai_ensure_project_labels gitlab "$project_path" || true
    fi

    encoded="$(gitlab_encode_path "$project_path")"
    payload="$(
        jq -n \
            --arg title "$title" \
            --arg description "$description" \
            --arg lbl "$label" \
            '{title: $title, description: $description, labels: $lbl}'
    )"
    gitlab_api POST "/projects/${encoded}/issues" -d "$payload"
}

# Print the web URL of an open issue with this exact title, or empty.
# Usage: gitlab_find_open_issue_url_by_title <project_path> <title>
gitlab_find_open_issue_url_by_title() {
    local project_path="$1"
    local title="$2"
    local encoded search_q body url

    encoded="$(gitlab_encode_path "$project_path")"
    search_q="$(jq -nr --arg s "$title" '$s | @uri')"
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/issues?state=opened&scope=all&in=title&per_page=20&search=${search_q}"
    )" || return 1

    url="$(
        jq -r --arg t "$title" \
            '[.[] | select(.title == $t) | .web_url] | first // empty' \
            <<<"$body"
    )"
    printf '%s' "$url"
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

# Global search: open issues with a label across all accessible projects.
# Prints TSV lines: project_path<TAB>iid
# Usage: gitlab_search_open_issues_with_label <label>
gitlab_search_open_issues_with_label() {
    local label="$1"
    local body

    body="$(
        gitlab_api GET \
            "/issues?labels=${label}&state=opened&scope=all&order_by=created_at&sort=asc&per_page=50"
    )" 2>/dev/null || return 0

    jq -r '
        .[]?
        | (.references.full // empty) as $ref
        | select($ref != "")
        | [($ref | sub("#[0-9]+$"; "")), (.iid | tostring)]
        | @tsv
    ' <<<"$body" 2>/dev/null || true
}

# Global search: open MRs with a label across all accessible projects.
# Prints TSV lines: project_path<TAB>iid
# Usage: gitlab_search_open_mrs_with_label <label>
gitlab_search_open_mrs_with_label() {
    local label="$1"
    local body

    body="$(
        gitlab_api GET \
            "/merge_requests?labels=${label}&state=opened&scope=all&order_by=created_at&sort=asc&per_page=50"
    )" 2>/dev/null || return 0

    jq -r '
        .[]?
        | (.references.full // empty) as $ref
        | select($ref != "")
        | [($ref | sub("![0-9]+$"; "")), (.iid | tostring)]
        | @tsv
    ' <<<"$body" 2>/dev/null || true
}

# Print oldest open MR iid with label "ai" (implement on branch), or empty.
gitlab_find_ai_mr() {
    local project_path="$1"
    local encoded body iid

    encoded="$(gitlab_encode_path "$project_path")"
    body="$(
        gitlab_api GET \
            "/projects/${encoded}/merge_requests?labels=ai&state=opened&order_by=created_at&sort=asc&per_page=1"
    )" || return 1

    iid="$(jq -r '.[0].iid // empty' <<<"$body")"
    printf '%s' "$iid"
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

    # Create any missing AI labels before mutating (runtime, not build-time only).
    if declare -F ai_ensure_project_labels >/dev/null 2>&1; then
        ai_ensure_project_labels gitlab "$project_path" || true
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

# Print all release tag_name values (one per line), paginated.
# Usage: gitlab_list_release_tags <project_path>
gitlab_list_release_tags() {
    local project_path="$1"
    local encoded page=1 body count

    encoded="$(gitlab_encode_path "$project_path")"

    while true; do
        body="$(
            gitlab_api GET \
                "/projects/${encoded}/releases?per_page=100&page=${page}"
        )" || return 1

        count="$(jq 'length' <<<"$body")"
        if [[ "$count" -eq 0 ]]; then
            break
        fi

        jq -r '.[].tag_name // empty' <<<"$body"

        if [[ "$count" -lt 100 ]]; then
            break
        fi

        page=$((page + 1))
    done
}

# Return 0 if a release exists for the given tag.
# Usage: gitlab_release_exists <project_path> <tag>
gitlab_release_exists() {
    local project_path="$1"
    local tag="$2"
    local encoded tag_encoded

    encoded="$(gitlab_encode_path "$project_path")"
    tag_encoded="$(printf '%s' "$tag" | jq -sRr @uri)"

    gitlab_api GET "/projects/${encoded}/releases/${tag_encoded}" >/dev/null 2>&1
}

# Create an upcoming (draft-like) GitLab release from ref, creating the tag if needed.
# Prints the release web URL on success.
# Usage: gitlab_create_upcoming_release <project_path> <tag> [ref] [description]
gitlab_create_upcoming_release() {
    local project_path="$1"
    local tag="$2"
    local ref="${3:-main}"
    local description="${4:-}"
    local encoded payload body url released_at

    encoded="$(gitlab_encode_path "$project_path")"
    # Far-future released_at → Upcoming Release in GitLab UI (closest to GitHub draft).
    released_at="2099-01-01T00:00:00Z"

    if [[ -z "$description" ]]; then
        description="Automated upcoming release created by the AI worker. Update or publish when ready."
    fi

    payload="$(
        jq -n \
            --arg name "$tag" \
            --arg tag_name "$tag" \
            --arg ref "$ref" \
            --arg description "$description" \
            --arg released_at "$released_at" \
            '{
                name: $name,
                tag_name: $tag_name,
                ref: $ref,
                description: $description,
                released_at: $released_at
            }'
    )"

    body="$(
        gitlab_api POST "/projects/${encoded}/releases" -d "$payload"
    )" || return 1

    # Prefer the project Releases page URL (API _links.self is the API endpoint).
    url="https://${GITLAB_HOST}/${project_path}/-/releases/${tag}"
    if [[ -z "$(jq -r '.tag_name // empty' <<<"$body")" ]]; then
        return 1
    fi

    printf '%s\n' "$url"
}

# Close a GitLab issue.
# Usage: gitlab_close_issue <project_path> <issue_iid>
gitlab_close_issue() {
    local project_path="$1"
    local issue_iid="$2"
    local encoded payload

    encoded="$(gitlab_encode_path "$project_path")"
    payload="$(jq -n '{state_event: "close"}')"

    gitlab_api PUT "/projects/${encoded}/issues/${issue_iid}" -d "$payload" >/dev/null
}
