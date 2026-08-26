#!/usr/bin/env bash
# Shared helpers for the AI worker. Source from other scripts; do not execute.

# Resolve BASE_DIR from the sourcing script when not already set.
: "${BASE_DIR:=/home/ubuntu/ai-worker}"
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

    if [[ -n "$project_path" ]]; then
        notes_json="$(gitlab_enrich_notes_with_roles "$project_path" "$notes_json")"
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
    ' <<<"${notes_json:-[]}"
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

    jq --argjson roles "$role_map" '
        map(
            . + {
                review_role: (
                    if (.user.login // "") as $u | $roles | has($u) then $roles[$u]
                    else "unknown" end
                )
            }
        )
    ' <<<"$comments_json"
}

# Build normalized discussion items for a GitHub pull request.
ai_github_discussion_items_from_pr() {
    local repo="$1"
    local pr_number="$2"
    local issue_comments review_comments reviews

    issue_comments="$(ai_enrich_github_comments_with_roles "$repo" "$(ai_github_fetch_issue_comments "$repo" "$pr_number")")"
    review_comments="$(ai_enrich_github_comments_with_roles "$repo" "$(ai_github_fetch_pr_review_comments "$repo" "$pr_number")")"
    reviews="$(ai_enrich_github_comments_with_roles "$repo" "$(ai_github_fetch_pr_reviews "$repo" "$pr_number")")"

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

    if [[ -n "$repo" ]]; then
        comments_json="$(ai_enrich_github_comments_with_roles "$repo" "$comments_json")"
    fi

    if [[ -z "$comments_json" || "$comments_json" == "[]" || "$comments_json" == "null" ]]; then
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
        ' <<<"$comments_json"
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
