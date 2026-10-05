#!/usr/bin/env bash
# Cross-repo follow-ups. Source after lib/common.sh.
#
# The agent writes .ai-related-tasks.json. These helpers match project
# names to github-projects.conf / gitlab-projects.conf, open an issue labeled
# "ai" in each related repo, and write tasks/*.md in the source repo.

# Text list of registered project names for the implement prompt.
ai_registered_projects_text() {
    local file entry project found=0

    printf '%s\n' "GitHub (github-projects.conf):"
    file="${BASE_DIR}/github-projects.conf"
    found=0
    if [[ -f "$file" ]]; then
        while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
            [[ -z "$entry" ]] && continue
            project="$(jq -r '.name // empty' <<<"$entry")"
            project="$(ai_related_trim "$project")"
            [[ -z "$project" ]] && continue
            printf '%s\n' "- ${project}"
            found=1
        done < <(ai_list_project_entries "$file")
    fi
    if [[ "$found" -eq 0 ]]; then
        printf '%s\n' "- (none)"
    fi

    printf '\n%s\n' "GitLab (gitlab-projects.conf):"
    file="${BASE_DIR}/gitlab-projects.conf"
    found=0
    if [[ -f "$file" ]]; then
        while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
            [[ -z "$entry" ]] && continue
            project="$(jq -r '.name // empty' <<<"$entry")"
            project="$(ai_related_trim "$project")"
            [[ -z "$project" ]] && continue
            printf '%s\n' "- ${project}"
            found=1
        done < <(ai_list_project_entries "$file")
    fi
    if [[ "$found" -eq 0 ]]; then
        printf '%s\n' "- (none)"
    fi
}

ai_related_trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
}

ai_related_slug() {
    local slug
    slug="$(
        printf '%s' "$1" \
            | tr '[:upper:]' '[:lower:]' \
            | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
    )"
    slug="${slug:0:50}"
    slug="${slug%-}"
    if [[ -z "$slug" ]]; then
        slug="task"
    fi
    printf '%s' "$slug"
}

ai_related_one_line() {
    local s="$1"
    s="${s//$'\n'/ }"
    s="${s//$'\r'/ }"
    while [[ "$s" == *"  "* ]]; do
        s="${s//  / }"
    done
    s="$(ai_related_trim "$s")"
    if [[ ${#s} -gt 200 ]]; then
        s="${s:0:200}"
    fi
    printf '%s' "$s"
}

# Print "canonical_name<TAB>dir" for a conf name match, or return 1.
ai_conf_match_project() {
    local file="$1"
    local want="$2"
    local want_lc entry project project_dir project_lc

    want_lc="$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')"
    [[ -n "$want_lc" ]] || return 1
    [[ -f "$file" ]] || return 1

    while IFS= read -r entry || [[ -n "${entry:-}" ]]; do
        [[ -z "$entry" ]] && continue
        project="$(jq -r '.name // empty' <<<"$entry")"
        project_dir="$(jq -r '.path // empty' <<<"$entry")"
        project="$(ai_related_trim "$project")"
        project_dir="$(ai_related_trim "$project_dir")"
        [[ -z "$project" || -z "$project_dir" ]] && continue
        project_lc="$(printf '%s' "$project" | tr '[:upper:]' '[:lower:]')"
        if [[ "$project_lc" == "$want_lc" ]]; then
            printf '%s\t%s\n' "$project" "$project_dir"
            return 0
        fi
    done < <(ai_list_project_entries "$file")

    return 1
}

# Print JSON {forge,name,dir} or return 1 (unknown) / 3 (listed but unusable).
ai_lookup_registered_project_exact() {
    local want="$1"
    local file match name dir rc

    file="${BASE_DIR}/github-projects.conf"
    rc=0
    match="$(ai_conf_match_project "$file" "$want")" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        name="${match%%$'\t'*}"
        dir="${match#*$'\t'}"
        if ! ai_validate_project_dir "$name" "$dir" >/dev/null; then
            echo "WARNING: Project '$name' in github-projects.conf is not a usable clone: $dir" >&2
            return 3
        fi
        jq -nc \
            --arg forge "github" \
            --arg name "$name" \
            --arg dir "$dir" \
            '{forge:$forge,name:$name,dir:$dir}'
        return 0
    fi

    file="${BASE_DIR}/gitlab-projects.conf"
    rc=0
    match="$(ai_conf_match_project "$file" "$want")" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        name="${match%%$'\t'*}"
        dir="${match#*$'\t'}"
        if ! ai_validate_project_dir "$name" "$dir" >/dev/null; then
            echo "WARNING: Project '$name' in gitlab-projects.conf is not a usable clone: $dir" >&2
            return 3
        fi
        jq -nc \
            --arg forge "gitlab" \
            --arg name "$name" \
            --arg dir "$dir" \
            '{forge:$forge,name:$name,dir:$dir}'
        return 0
    fi

    return 1
}

ai_lookup_registered_project() {
    local want="$1"
    local out rc

    rc=0
    out="$(ai_lookup_registered_project_exact "$want")" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        printf '%s\n' "$out"
        return 0
    fi
    if [[ "$rc" -eq 3 ]]; then
        return 3
    fi

    if [[ "$want" == */* && "${want##*/}" != "$want" ]]; then
        ai_lookup_registered_project_exact "${want##*/}"
        return $?
    fi

    return 1
}

# Copy the agent JSON out of the project tree. Return 1 if missing or empty.
# Usage: ai_capture_related_tasks_file <in_project_path> <saved_path>
ai_capture_related_tasks_file() {
    local src="$1"
    local saved="$2"
    local bytes

    if [[ -z "$src" || -z "$saved" ]]; then
        return 1
    fi

    if [[ ! -f "$src" ]]; then
        echo "WARNING: Related-tasks file missing: $src" >&2
        echo "WARNING: No cross-repo issues will be opened for this run." >&2
        return 1
    fi

    bytes="$(wc -c < "$src" | tr -d ' ')"
    if [[ "$bytes" -eq 0 ]]; then
        echo "WARNING: Related-tasks file is empty: $src" >&2
        rm -f "$src"
        return 1
    fi

    mkdir -p "$(dirname "$saved")"
    cp "$src" "$saved"
    rm -f "$src"
    echo "Captured related-service tasks ($bytes bytes) -> $saved" >&2
    return 0
}

ai_related_ensure_gitlab() {
    if ! declare -F gitlab_create_issue >/dev/null 2>&1; then
        # shellcheck source=gitlab.sh
        source "$BASE_DIR/lib/gitlab.sh"
    fi
}

ai_related_issue_body() {
    local source_project="$1"
    local source_ref="$2"
    local doc="$3"
    local why="$4"
    local summary="$5"
    local acceptance_json="$6"
    local count

    printf '%s\n\n' '<!-- ai-worker-related-task -->'
    printf 'This issue was opened automatically because a change in **%s** may require work in this repository.\n\n' \
        "$source_project"
    printf '**Source:** %s\n\n' "$source_ref"
    printf '**Documentation:** %s\n\n' "${doc:-unknown}"
    printf '%s\n\n' '## Why this repository is affected'
    printf '%s\n\n' "${why:-None}"
    printf '%s\n\n' '## What to implement'
    printf '%s\n\n' "${summary:-None}"
    printf '%s\n\n' '## Acceptance'

    count="$(jq 'length' <<<"$acceptance_json")"
    if [[ "$count" -eq 0 ]]; then
        printf '%s\n' '- None'
    else
        jq -r '.[] | "- " + .' <<<"$acceptance_json"
    fi

    printf '\n%s\n' \
        'The `ai` label queues this issue for the AI worker. Do not open further cross-repository follow-ups for this same change unless this issue explicitly asks for them.'
}

ai_related_find_open_issue_url() {
    local forge="$1"
    local repo_dir="$2"
    local title="$3"
    local repo path url

    if [[ "${AI_RELATED_TASKS_DRY_RUN:-}" == "1" ]]; then
        printf ''
        return 0
    fi

    if [[ "$forge" == "github" ]]; then
        repo="$(
            cd "$repo_dir" && gh repo view --json nameWithOwner --jq '.nameWithOwner'
        )" || return 1
        url="$(
            gh issue list \
                --repo "$repo" \
                --state open \
                --limit 100 \
                --json title,url \
                | jq -r --arg t "$title" '.[] | select(.title == $t) | .url' \
                | head -n 1
        )" || return 1
        printf '%s' "$url"
        return 0
    fi

    ai_related_ensure_gitlab || return 1
    path="$(gitlab_resolve_project_path "$repo_dir")" || return 1
    url="$(gitlab_find_open_issue_url_by_title "$path" "$title")" || return 1
    printf '%s' "$url"
}

ai_related_create_issue() {
    local forge="$1"
    local project_name="$2"
    local repo_dir="$3"
    local title="$4"
    local body="$5"
    local repo path body_file json url

    if [[ "${AI_RELATED_TASKS_DRY_RUN:-}" == "1" ]]; then
        printf 'https://example.invalid/%s/%s/issues/dry-run\n' "$forge" "$project_name"
        return 0
    fi

    if [[ "$forge" == "github" ]]; then
        repo="$(
            cd "$repo_dir" && gh repo view --json nameWithOwner --jq '.nameWithOwner'
        )" || return 1
        body_file="$(mktemp)"
        printf '%s\n' "$body" > "$body_file"
        url="$(
            gh issue create \
                --repo "$repo" \
                --title "$title" \
                --body-file "$body_file" \
                --label "ai"
        )" || {
            rm -f "$body_file"
            return 1
        }
        rm -f "$body_file"
        url="$(printf '%s\n' "$url" | grep -E '^https?://' | tail -n 1 || true)"
        [[ -n "$url" ]] || return 1
        printf '%s\n' "$url"
        return 0
    fi

    ai_related_ensure_gitlab || return 1
    path="$(gitlab_resolve_project_path "$repo_dir")" || return 1
    json="$(gitlab_create_issue "$path" "$title" "$body" "ai")" || return 1
    url="$(jq -r '.web_url // empty' <<<"$json")"
    [[ -n "$url" ]] || return 1
    printf '%s\n' "$url"
}

# Write tasks/<date>-<project>-<slug>.md. Prints the path relative to PROJECT_DIR.
ai_related_write_markdown() {
    local project_name="$1"
    local forge_label="$2"
    local title="$3"
    local summary="$4"
    local why="$5"
    local doc="$6"
    local acceptance_json="$7"
    local issue_url="$8"
    local reason="$9"
    local source_ref="${10}"
    local source_project="${11}"
    local dir slug file n rel count

    dir="${PROJECT_DIR}/tasks"
    mkdir -p "$dir"

    slug="$(ai_related_slug "${project_name}-$(ai_related_slug "$title")")"
    file="${dir}/$(date -u '+%Y-%m-%d')-${slug}.md"
    n=2
    while [[ -e "$file" ]]; do
        file="${dir}/$(date -u '+%Y-%m-%d')-${slug}-${n}.md"
        n=$((n + 1))
    done

    {
        printf '# %s\n\n' "$title"
        printf -- '- Project: `%s`\n' "$project_name"
        printf -- '- Forge: %s\n' "$forge_label"
        if [[ -n "$issue_url" ]]; then
            printf -- '- Issue: %s\n' "$issue_url"
            printf -- '- Label: `ai`\n'
        else
            printf -- '- Issue: not created (%s)\n' "${reason:-unknown}"
        fi
        printf -- '- Source: %s\n' "$source_ref"
        printf -- '- Source project: `%s`\n' "$source_project"
        printf -- '- Documentation: %s\n\n' "${doc:-unknown}"
        printf '%s\n\n' '## Why this service is affected'
        printf '%s\n\n' "${why:-None}"
        printf '%s\n\n' '## What to implement'
        printf '%s\n\n' "${summary:-None}"
        printf '%s\n\n' '## Acceptance'
        count="$(jq 'length' <<<"$acceptance_json")"
        if [[ "$count" -eq 0 ]]; then
            printf '%s\n' '- None'
        else
            jq -r '.[] | "- " + .' <<<"$acceptance_json"
        fi
        printf '\n'
    } > "$file"

    rel="${file#"${PROJECT_DIR}/"}"
    if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        if git -C "$PROJECT_DIR" check-ignore -q "$rel"; then
            echo "WARNING: ${rel} is gitignored and will not be committed." >&2
        fi
    fi

    printf '%s\n' "$rel"
}

# Open related issues and write tasks/*.md. Never fails the caller.
# Usage: ai_apply_related_tasks <saved_json> <source_project> <source_ref> [source_body]
# Requires PROJECT_DIR. Appends a section to NOTES_SAVED when that file exists.
ai_apply_related_tasks() {
    local saved="$1"
    local source_project="$2"
    local source_ref="$3"
    local source_body="${4:-}"
    local normalized item project title summary why doc acceptance
    local found rc forge name dir issue_url reason forge_label rel
    local body notes_section="" count existing

    if [[ -z "$saved" || ! -f "$saved" ]]; then
        echo "No related-service task file to apply."
        return 0
    fi

    if [[ "$source_body" == *"ai-worker-related-task"* ]]; then
        echo "Skipping related-service tasks: this item is already a related-service follow-up."
        return 0
    fi

    if [[ -z "${PROJECT_DIR:-}" || ! -d "$PROJECT_DIR" ]]; then
        echo "WARNING: PROJECT_DIR is not set; cannot file related-service tasks." >&2
        return 0
    fi

    if ! normalized="$(
        jq -c '
            (if type == "array" then {tasks: .} else . end) as $root
            | ($root.tasks // [])
            | map(select((.project | type) == "string" and (.title | type) == "string"))
            | map({
                project: .project,
                title: .title,
                summary: (.summary // "" | tostring),
                why: (.why // "" | tostring),
                doc: (.doc // "" | tostring),
                acceptance: (
                    if (.acceptance | type) == "array"
                    then [.acceptance[] | tostring | select(length > 0)]
                    else []
                    end
                )
            })
        ' "$saved" 2>/dev/null
    )"; then
        echo "WARNING: Related-tasks file is not valid JSON: $saved" >&2
        return 0
    fi

    count="$(jq 'length' <<<"$normalized")"
    if [[ "$count" -eq 0 ]]; then
        echo "No related-service tasks to file."
        return 0
    fi

    while IFS= read -r item; do
        [[ -z "$item" ]] && continue

        project="$(ai_related_trim "$(jq -r '.project' <<<"$item")")"
        title="$(ai_related_one_line "$(jq -r '.title' <<<"$item")")"
        summary="$(jq -r '.summary' <<<"$item")"
        why="$(jq -r '.why' <<<"$item")"
        doc="$(jq -r '.doc' <<<"$item")"
        acceptance="$(jq -c '.acceptance' <<<"$item")"

        if [[ -z "$project" || -z "$title" ]]; then
            echo "WARNING: Skipping related task with an empty project or title." >&2
            continue
        fi

        if [[ "$project" == *..* ]]; then
            echo "WARNING: Skipping related task with an invalid project name: $project" >&2
            continue
        fi

        if [[ ! "$project" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
            echo "WARNING: Skipping related task with an invalid project name: $project" >&2
            continue
        fi

        if [[ "$(printf '%s' "$project" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$source_project" | tr '[:upper:]' '[:lower:]')" ]]; then
            echo "Skipping related task for the current project: $project"
            continue
        fi

        issue_url=""
        reason=""
        forge_label="unknown"
        name="$project"
        found=""
        rc=0
        found="$(ai_lookup_registered_project "$project")" || rc=$?

        if [[ "$rc" -eq 0 ]]; then
            forge="$(jq -r '.forge' <<<"$found")"
            name="$(jq -r '.name' <<<"$found")"
            dir="$(jq -r '.dir' <<<"$found")"
            if [[ "$forge" == "github" ]]; then
                forge_label="GitHub"
            else
                forge_label="GitLab"
            fi

            existing=""
            if ! existing="$(ai_related_find_open_issue_url "$forge" "$dir" "$title")"; then
                echo "WARNING: Could not search open issues in ${name}; trying to create one." >&2
                existing=""
            fi

            if [[ -n "$existing" ]]; then
                issue_url="$existing"
                reason="already open"
                echo "Related task already open in ${name}: ${issue_url}"
            else
                body="$(
                    ai_related_issue_body \
                        "$source_project" \
                        "$source_ref" \
                        "$doc" \
                        "$why" \
                        "$summary" \
                        "$acceptance"
                )"
                if issue_url="$(ai_related_create_issue "$forge" "$name" "$dir" "$title" "$body")"; then
                    issue_url="$(ai_related_trim "$issue_url")"
                    echo "Opened related task in ${name} (${forge_label}): ${issue_url}"
                else
                    issue_url=""
                    reason="issue creation failed"
                    echo "WARNING: Could not open an issue in ${name} (${forge_label})." >&2
                fi
            fi
        elif [[ "$rc" -eq 3 ]]; then
            reason="listed in the project conf, but the local clone is missing or is not a git repo"
            echo "WARNING: Not opening an issue for ${project}: ${reason}." >&2
        else
            reason="not listed in github-projects.conf or gitlab-projects.conf"
            echo "WARNING: Not opening an issue for ${project}: ${reason}." >&2
        fi

        if ! rel="$(
            ai_related_write_markdown \
                "$name" \
                "$forge_label" \
                "$title" \
                "$summary" \
                "$why" \
                "$doc" \
                "$acceptance" \
                "$issue_url" \
                "$reason" \
                "$source_ref" \
                "$source_project"
        )"; then
            echo "WARNING: Could not write task markdown for ${name}." >&2
            continue
        fi

        echo "Wrote related-task doc: ${rel}"
        notes_section+="- \`${name}\`: ${title}"
        if [[ -n "$issue_url" ]]; then
            notes_section+=" — ${issue_url}"
        else
            notes_section+=" — not filed (${reason})"
        fi
        notes_section+=" — \`${rel}\`"$'\n'
    done < <(jq -c '.[]' <<<"$normalized")

    if [[ -n "$notes_section" && -n "${NOTES_SAVED:-}" && -f "$NOTES_SAVED" ]]; then
        {
            printf '\n%s\n\n' '## Related services'
            printf '%s\n' "$notes_section"
        } >> "$NOTES_SAVED"
        echo "Appended related-service notes to $NOTES_SAVED"
    fi

    return 0
}
