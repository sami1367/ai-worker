#!/usr/bin/env bash
# no-change Q&A may start while an open AI PR/MR would block implement issues.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export BASE_DIR="$TMP/worker"
mkdir -p "$BASE_DIR"
export GITLAB_TOKEN="test-token-not-real"
export GITLAB_HOST="gitlab.example.test"

# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"
# shellcheck source=../lib/gitlab.sh
source "$ROOT/lib/gitlab.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

GITLAB_API_LOG="$TMP/gitlab-api.log"
: > "$GITLAB_API_LOG"

gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2

    printf '%s %s\n' "$method" "$path" >> "$GITLAB_API_LOG"

    case "$path" in
        /user)
            printf '{"id":42,"username":"ai-bot"}'
            ;;
        /projects/*/issues\?*)
            if [[ "$path" == *labels=ai,no-change* ]]; then
                printf '[{"iid":33,"title":"qa","created_at":"2026-01-01T00:00:00Z"}]'
            elif [[ "$path" == *labels=ai* && "$path" != *labels=ai-* && "$path" != *labels=ai,* ]]; then
                printf '[{"iid":7,"title":"implement","created_at":"2026-01-02T00:00:00Z"}]'
            else
                printf '[]'
            fi
            ;;
        *)
            printf '{}'
            ;;
    esac
}

gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
    if [[ "$1" == "issue" && "$2" == "list" ]]; then
        local labels=()
        local i=0
        local args=("$@")
        local jq_expr=""
        local prev=""
        for ((i = 0; i < ${#args[@]}; i++)); do
            if [[ "${args[$i]}" == "--label" ]]; then
                labels+=("${args[$((i + 1))]}")
            fi
            if [[ "$prev" == "--jq" ]]; then
                jq_expr="${args[$i]}"
            fi
            prev="${args[$i]}"
        done
        local joined
        joined="$(IFS=,; echo "${labels[*]}")"
        local payload='[]'
        if [[ "$joined" == "ai,no-change" || "$joined" == "no-change,ai" ]]; then
            payload='[{"number":33,"createdAt":"2026-01-01T00:00:00Z"}]'
        elif [[ "$joined" == "ai" ]]; then
            payload='[{"number":7,"createdAt":"2026-01-02T00:00:00Z"}]'
        fi
        if [[ -n "$jq_expr" ]]; then
            printf '%s' "$payload" | jq -r "$jq_expr"
        elif [[ "$payload" != '[]' ]]; then
            printf '%s' "$(jq -r '.[0].number // empty' <<<"$payload")"
        else
            printf ''
        fi
        return 0
    fi
    return 0
}

: > "$TMP/gh.log"
num="$(github_find_ai_no_change_issue "owner/repo")"
[[ "$num" == "33" ]] || fail "expected github no-change issue 33, got '$num'"
grep -q -- '--label' "$TMP/gh.log" || fail "github_find_ai_no_change_issue missing --label"

: > "$GITLAB_API_LOG"
iid="$(gitlab_find_ai_no_change_issue "group/project")" || fail "gitlab_find_ai_no_change_issue failed"
[[ "$iid" == "33" ]] || fail "expected gitlab no-change iid 33, got '$iid'"
grep -q 'labels=ai,no-change' "$GITLAB_API_LOG" || fail "expected labels=ai,no-change query"

# Empty in-flight → keep candidate
picked="$(ai_pick_issue_despite_in_flight "7" "" github_find_ai_no_change_issue "owner/repo")"
[[ "$picked" == "7" ]] || fail "expected candidate 7 when not in-flight, got '$picked'"

# ai-working always blocks
picked="$(ai_pick_issue_despite_in_flight "7" \
    'github owner/repo: open issue #1 is labeled ai-working' \
    github_find_ai_no_change_issue "owner/repo")"
[[ -z "$picked" ]] || fail "ai-working must block even with no-change available, got '$picked'"

# Open AI PR → switch to no-change issue
picked="$(ai_pick_issue_despite_in_flight "7" \
    'github owner/repo: open AI-labeled pull request #12 (ai/issue-3, ai-pr)' \
    github_find_ai_no_change_issue "owner/repo")"
[[ "$picked" == "33" ]] || fail "expected no-change issue 33 under open PR, got '$picked'"

# Open AI PR with no no-change issue → skip
gh() {
    if [[ "$1" == "issue" && "$2" == "list" ]]; then
        printf ''
        return 0
    fi
    return 0
}
picked="$(ai_pick_issue_despite_in_flight "7" \
    'github owner/repo: open AI-labeled pull request #12 (ai/issue-3, ai-pr)' \
    github_find_ai_no_change_issue "owner/repo")"
[[ -z "$picked" ]] || fail "expected empty when no no-change issue, got '$picked'"

# GitLab open MR path
picked="$(ai_pick_issue_despite_in_flight "7" \
    'gitlab group/project: open AI-labeled merge request !100 (ai/issue-1, ai-pr)' \
    gitlab_find_ai_no_change_issue "group/project")"
[[ "$picked" == "33" ]] || fail "expected gitlab no-change 33 under open MR, got '$picked'"

echo "OK: no-change-open-pr"
