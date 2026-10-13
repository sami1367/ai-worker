#!/usr/bin/env bash
# Exercises label-only issue pickup helpers without calling GitHub or GitLab.
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
    local payload=""

    printf '%s %s' "$method" "$path" >> "$GITLAB_API_LOG"
    if [[ "${1:-}" == "-d" ]]; then
        payload="${2:-}"
        printf ' %s' "$payload" >> "$GITLAB_API_LOG"
    fi
    printf '\n' >> "$GITLAB_API_LOG"

    case "$path" in
        /user)
            printf '{"id":42,"username":"ai-bot"}'
            ;;
        /projects/*/issues\?*)
            if [[ "$path" == *labels=ai-working* ]]; then
                printf '[]'
            elif [[ "$path" == *labels=ai* && "$path" != *labels=ai-* ]]; then
                if [[ "$path" == *assignee_id=* ]]; then
                    printf '[]'
                else
                    printf '[{"iid":7,"title":"ai issue"}]'
                fi
            else
                printf '[]'
            fi
            ;;
        /projects/*/issues)
            printf '{"iid":99,"web_url":"https://gitlab.example.test/g/p/-/issues/99"}'
            ;;
        *)
            printf '{}'
            ;;
    esac
}

gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "issue" && "$2" == "list" ]]; then
        local has_assignee=0
        local has_label=0
        local arg
        for arg in "$@"; do
            if [[ "$arg" == "@me" || "$arg" == "--assignee" ]]; then
                has_assignee=1
            fi
            if [[ "$arg" == "ai" ]]; then
                has_label=1
            fi
        done
        if [[ "$has_assignee" -eq 0 && "$has_label" -eq 1 ]]; then
            printf '12'
        else
            printf ''
        fi
        return 0
    fi
    return 0
}

uid="$(gitlab_current_user_id)" || fail "gitlab_current_user_id failed"
[[ "$uid" == "42" ]] || fail "expected user id 42, got $uid"
grep -q '^GET /user$' "$GITLAB_API_LOG" || fail "expected /user call"

: > "$GITLAB_API_LOG"
iid="$(gitlab_find_ai_issue "group/project")" || fail "gitlab_find_ai_issue failed"
[[ "$iid" == "7" ]] || fail "expected iid 7, got '$iid'"
grep -q 'labels=ai' "$GITLAB_API_LOG" || fail "ai issue query missing labels=ai"
if grep -q 'assignee_id=' "$GITLAB_API_LOG"; then
    fail "ai issue pickup must not filter by assignee"
fi
if grep -q '^GET /user$' "$GITLAB_API_LOG"; then
    fail "find_ai_issue should not resolve current user"
fi

# In-flight label lookup must not require assignee.
: > "$GITLAB_API_LOG"
working="$(gitlab_find_open_issue_with_label "group/project" "ai-working" || true)"
[[ -z "$working" ]] || fail "mock returned empty list; expected empty iid"
grep -q 'labels=ai-working' "$GITLAB_API_LOG" || fail "ai-working query missing"
if grep -q 'assignee_id=' "$GITLAB_API_LOG"; then
    fail "ai-working lookup must not filter by assignee"
fi

: > "$GITLAB_API_LOG"
json="$(gitlab_create_issue "group/project" "Title" "Body" "ai")" || fail "create issue failed"
[[ "$(jq -r '.iid' <<<"$json")" == "99" ]] || fail "create issue response"
grep -Eq '"labels"[[:space:]]*:[[:space:]]*"ai"' "$GITLAB_API_LOG" || fail "create issue missing labels"
if grep -q 'assignee_ids' "$GITLAB_API_LOG"; then
    fail "create issue must not set assignee_ids"
fi

: > "$TMP/gh.log"
num="$(github_find_ai_issue "owner/repo")"
[[ "$num" == "12" ]] || fail "expected github issue 12, got '$num'"
if grep -q -- '--assignee' "$TMP/gh.log"; then
    fail "github_find_ai_issue must not use --assignee"
fi
if grep -q -- '@me' "$TMP/gh.log"; then
    fail "github_find_ai_issue must not use @me"
fi
grep -q -- '--label' "$TMP/gh.log" || fail "github_find_ai_issue missing --label"

# Empty /user payload must fail closed for user-id helper.
gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2
    if [[ "$path" == "/user" ]]; then
        printf '{"username":"no-id"}'
        return 0
    fi
    fail "unexpected gitlab_api after empty user: $method $path"
}
if gitlab_current_user_id >/dev/null 2>&1; then
    fail "gitlab_current_user_id should fail without id"
fi

# Related-task GitHub create must label ai without assignee (non-dry-run).
# shellcheck source=../lib/related-tasks.sh
source "$ROOT/lib/related-tasks.sh"

unset AI_RELATED_TASKS_DRY_RUN
gh() {
    printf '%s\n' "$*" >> "$TMP/gh-create.log"
    if [[ "$1" == "repo" && "$2" == "view" ]]; then
        printf 'owner/billing\n'
        return 0
    fi
    if [[ "$1" == "issue" && "$2" == "create" ]]; then
        printf 'https://github.com/owner/billing/issues/5\n'
        return 0
    fi
    return 0
}

: > "$TMP/gh-create.log"
git_repo() { mkdir -p "$1"; git -C "$1" init -q; }
git_repo "$TMP/billing-create"
url="$(ai_related_create_issue "github" "billing" "$TMP/billing-create" "Follow-up" "body")" \
    || fail "ai_related_create_issue failed"
[[ "$url" == "https://github.com/owner/billing/issues/5" ]] || fail "unexpected create url: $url"
grep -q -- '--label' "$TMP/gh-create.log" || fail "related create missing --label"
grep -q -- 'ai' "$TMP/gh-create.log" || fail "related create missing ai label"
if grep -q -- '--assignee' "$TMP/gh-create.log"; then
    fail "related create must not set --assignee"
fi
if grep -q -- '@me' "$TMP/gh-create.log"; then
    fail "related create must not set @me"
fi

echo "assignee-filter tests passed"
