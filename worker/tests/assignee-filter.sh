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
                # Pickup requires assignee_id of the connected user.
                if [[ "$path" == *assignee_id=42* ]]; then
                    printf '[{"iid":7,"title":"ai issue"}]'
                else
                    printf '[]'
                fi
            else
                printf '[]'
            fi
            ;;
        /projects/*/merge_requests\?*)
            # Open-MR gating requires author_id of the configured GitLab user.
            if [[ "$path" != *author_id=42* ]]; then
                printf '[]'
            elif [[ "$path" != *labels=* ]]; then
                printf '[{"iid":372,"source_branch":"feat/human","created_at":"2026-01-01T00:00:00Z","author":{"id":42,"username":"ai-bot"}}]'
            elif [[ "$path" == *labels=ai-pr* ]]; then
                printf '[{"iid":100,"source_branch":"ai/issue-1","created_at":"2026-02-01T00:00:00Z","author":{"id":42,"username":"ai-bot"}}]'
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
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
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
        # Only return an issue when both AI label and @me assignee are requested.
        # Mimic `gh --jq`: emit the selected number (and createdAt via tab when JSON path used).
        if [[ "$has_assignee" -eq 1 && "$has_label" -eq 1 ]]; then
            local jq_expr=""
            local prev=""
            for arg in "$@"; do
                if [[ "$prev" == "--jq" ]]; then
                    jq_expr="$arg"
                fi
                prev="$arg"
            done
            if [[ -n "$jq_expr" ]]; then
                printf '%s' '[{"number":12,"createdAt":"2026-01-02T00:00:00Z"}]' | jq -r "$jq_expr"
            else
                printf '12'
            fi
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
grep -q 'assignee_id=42' "$GITLAB_API_LOG" || fail "ai issue pickup must filter by assignee_id"
grep -q '^GET /user$' "$GITLAB_API_LOG" || fail "find_ai_issue must resolve current user for assignee filter"

# In-flight label lookup must not require assignee.
: > "$GITLAB_API_LOG"
working="$(gitlab_find_open_issue_with_label "group/project" "ai-working" || true)"
[[ -z "$working" ]] || fail "mock returned empty list; expected empty iid"
grep -q 'labels=ai-working' "$GITLAB_API_LOG" || fail "ai-working query missing"
if grep -q 'assignee_id=' "$GITLAB_API_LOG"; then
    fail "ai-working lookup must not filter by assignee"
fi

# Open-MR in-flight check prefers AI implement labels (ignore human MRs).
: > "$GITLAB_API_LOG"
mr_desc="$(gitlab_find_open_mr "group/project" || true)"
[[ "$mr_desc" == "!100 (ai/issue-1, ai-pr)" ]] \
    || fail "expected AI-labeled MR desc, got '$mr_desc'"
grep -q 'labels=ai-pr' "$GITLAB_API_LOG" || fail "open MR check missing labels=ai-pr"
grep -q 'author_id=42' "$GITLAB_API_LOG" || fail "open MR check must filter by author_id"
# When a labeled MR is found, do not need the unlabeled fallback query.
if grep 'merge_requests?' "$GITLAB_API_LOG" | grep -vq 'labels='; then
    fail "open MR check must not query unlabeled open MRs when labeled hits exist"
fi

# When no AI-labeled MRs exist, human open MRs must not block.
gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2
    printf '%s %s\n' "$method" "$path" >> "$GITLAB_API_LOG"
    case "$path" in
        /user)
            printf '{"id":42,"username":"ai-bot"}'
            ;;
        /projects/*/merge_requests\?*)
            if [[ "$path" != *author_id=42* ]]; then
                printf '[]'
            elif [[ "$path" != *labels=* ]]; then
                printf '[{"iid":372,"source_branch":"feat/human","created_at":"2026-01-01T00:00:00Z","author":{"id":42,"username":"ai-bot"}}]'
            else
                printf '[]'
            fi
            ;;
        *)
            printf '{}'
            ;;
    esac
}
: > "$GITLAB_API_LOG"
mr_desc="$(gitlab_find_open_mr "group/project" || true)"
[[ -z "$mr_desc" ]] || fail "human-only open MRs must not block, got '$mr_desc'"
grep -q 'labels=ai-pr' "$GITLAB_API_LOG" || fail "expected labeled MR queries even when empty"
grep -q 'author_id=42' "$GITLAB_API_LOG" || fail "human-only MR check must filter by author_id"
# Unlabeled fallback runs only after labeled queries miss.
grep 'merge_requests?' "$GITLAB_API_LOG" | grep -vq 'labels=' \
    || fail "expected unlabeled MR fallback query when labels miss"

# Unlabeled AI branch MRs still block (label-apply failure safety net).
gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2
    printf '%s %s\n' "$method" "$path" >> "$GITLAB_API_LOG"
    case "$path" in
        /user)
            printf '{"id":42,"username":"ai-bot"}'
            ;;
        /projects/*/merge_requests\?*)
            if [[ "$path" != *author_id=42* ]]; then
                printf '[]'
            elif [[ "$path" != *labels=* ]]; then
                printf '[{"iid":50,"source_branch":"ai/issue-9","created_at":"2026-03-01T00:00:00Z","author":{"id":42,"username":"ai-bot"}},{"iid":51,"source_branch":"feat/human","created_at":"2026-01-01T00:00:00Z","author":{"id":42,"username":"ai-bot"}}]'
            else
                printf '[]'
            fi
            ;;
        *)
            printf '{}'
            ;;
    esac
}
: > "$GITLAB_API_LOG"
mr_desc="$(gitlab_find_open_mr "group/project" || true)"
[[ "$mr_desc" == "!50 (ai/issue-9, ai-branch)" ]] \
    || fail "expected unlabeled ai/issue-* MR to block, got '$mr_desc'"

# Other-user ai-pr MRs must not block even when labeled.
gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2
    printf '%s %s\n' "$method" "$path" >> "$GITLAB_API_LOG"
    case "$path" in
        /user)
            printf '{"id":42,"username":"ai-bot"}'
            ;;
        /projects/*/merge_requests\?*)
            # Simulate forge returning nothing for author_id=42; other-user MRs
            # are excluded server-side by the author_id filter.
            printf '[]'
            ;;
        *)
            printf '{}'
            ;;
    esac
}
: > "$GITLAB_API_LOG"
mr_desc="$(gitlab_find_open_mr "group/project" || true)"
[[ -z "$mr_desc" ]] || fail "other-user ai-pr MRs must not block, got '$mr_desc'"
grep -q 'author_id=42' "$GITLAB_API_LOG" || fail "other-user MR check must filter by author_id"

# Restore create-issue mock for following tests.
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
        /projects/*/issues)
            printf '{"iid":99,"web_url":"https://gitlab.example.test/g/p/-/issues/99"}'
            ;;
        *)
            printf '{}'
            ;;
    esac
}

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
grep -q -- '--assignee' "$TMP/gh.log" || fail "github_find_ai_issue must use --assignee"
grep -q -- '@me' "$TMP/gh.log" || fail "github_find_ai_issue must use @me"
grep -q -- '--label' "$TMP/gh.log" || fail "github_find_ai_issue missing --label"

# Open-PR in-flight check must list PRs without --label (Search API) and filter
# client-side; unlabeled ai/issue-* heads still block; human PRs do not.
gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
    if [[ "$1" == "pr" && "$2" == "list" ]]; then
        local arg
        for arg in "$@"; do
            if [[ "$arg" == "--label" || "$arg" == -l ]]; then
                fail "github_list_open_prs_json must not use --label (Search API)"
            fi
            if [[ "$arg" == *author* ]]; then
                : # author field is required for configured-user gating
            fi
        done
        # Require author in --json fields
        local json_fields=""
        local prev=""
        for arg in "$@"; do
            if [[ "$prev" == "--json" ]]; then
                json_fields="$arg"
            fi
            prev="$arg"
        done
        [[ "$json_fields" == *author* ]] || fail "github_list_open_prs_json must request author"
        cat <<'EOF'
[
  {"number":3,"headRefName":"feat/human","createdAt":"2026-01-01T00:00:00Z","labels":[{"name":"bug"}],"author":{"login":"ai-bot"}},
  {"number":12,"headRefName":"ai/issue-3","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"ai-pr"}],"author":{"login":"ai-bot"}},
  {"number":15,"headRefName":"ai/issue-9-retry","createdAt":"2026-03-01T00:00:00Z","labels":[],"author":{"login":"ai-bot"}}
]
EOF
        return 0
    fi
    return 0
}
: > "$TMP/gh.log"
pr_desc="$(github_find_open_pr "owner/repo" || true)"
[[ "$pr_desc" == "#12 (ai/issue-3, ai-pr)" ]] \
    || fail "expected oldest AI-labeled PR by configured user, got '$pr_desc'"
if grep -q -- '--label' "$TMP/gh.log"; then
    fail "github_find_open_pr must not use gh pr list --label"
fi

gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
    if [[ "$1" == "pr" && "$2" == "list" ]]; then
        cat <<'EOF'
[
  {"number":3,"headRefName":"feat/human","createdAt":"2026-01-01T00:00:00Z","labels":[{"name":"bug"}],"author":{"login":"someone"}},
  {"number":15,"headRefName":"ai/issue-9","createdAt":"2026-03-01T00:00:00Z","labels":[],"author":{"login":"ai-bot"}}
]
EOF
        return 0
    fi
    return 0
}
: > "$TMP/gh.log"
pr_desc="$(github_find_open_pr "owner/repo" || true)"
[[ "$pr_desc" == "#15 (ai/issue-9, ai-branch)" ]] \
    || fail "expected unlabeled ai/issue-* PR by configured user to block, got '$pr_desc'"

gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
    if [[ "$1" == "pr" && "$2" == "list" ]]; then
        cat <<'EOF'
[
  {"number":3,"headRefName":"feat/human","createdAt":"2026-01-01T00:00:00Z","labels":[{"name":"bug"}],"author":{"login":"someone"}},
  {"number":99,"headRefName":"ai/issue-7","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"ai-pr"}],"author":{"login":"other-user"}}
]
EOF
        return 0
    fi
    return 0
}
: > "$TMP/gh.log"
pr_desc="$(github_find_open_pr "owner/repo" || true)"
[[ -z "$pr_desc" ]] || fail "other-user ai-pr PRs must not block, got '$pr_desc'"

gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
    if [[ "$1" == "pr" && "$2" == "list" ]]; then
        cat <<'EOF'
[
  {"number":8,"headRefName":"ai/issue-1","createdAt":"2026-01-02T00:00:00Z","labels":[{"name":"ai"}],"assignees":[{"login":"ai-bot"}]},
  {"number":9,"headRefName":"fix","createdAt":"2026-01-01T00:00:00Z","labels":[{"name":"ai-review"}],"assignees":[{"login":"ai-bot"}]},
  {"number":10,"headRefName":"other","createdAt":"2025-12-01T00:00:00Z","labels":[{"name":"ai-review"}],"assignees":[{"login":"someone-else"}]},
  {"number":11,"headRefName":"none","createdAt":"2025-11-01T00:00:00Z","labels":[{"name":"ai"}],"assignees":[]}
]
EOF
        return 0
    fi
    return 0
}
: > "$TMP/gh.log"
pr_num="$(github_find_open_pr_with_label "owner/repo" "ai" || true)"
[[ "$pr_num" == "8" ]] || fail "expected PR #8 with ai label assigned to me, got '$pr_num'"
pr_num="$(github_find_open_pr_with_label "owner/repo" "ai-review" || true)"
[[ "$pr_num" == "9" ]] || fail "expected PR #9 with ai-review assigned to me, got '$pr_num'"
# Unassigned / other-assignee ai-review must not be selected.
gh() {
    printf '%s\n' "$*" >> "$TMP/gh.log"
    if [[ "$1" == "api" && "$2" == "user" ]]; then
        printf 'ai-bot\n'
        return 0
    fi
    if [[ "$1" == "pr" && "$2" == "list" ]]; then
        cat <<'EOF'
[
  {"number":10,"headRefName":"other","createdAt":"2025-12-01T00:00:00Z","labels":[{"name":"ai-review"}],"assignees":[{"login":"someone-else"}]},
  {"number":11,"headRefName":"none","createdAt":"2025-11-01T00:00:00Z","labels":[{"name":"ai-review"}],"assignees":[]}
]
EOF
        return 0
    fi
    return 0
}
: > "$TMP/gh.log"
pr_num="$(github_find_open_pr_with_label "owner/repo" "ai-review" || true)"
[[ -z "$pr_num" ]] || fail "ai-review without my assignee must be skipped, got '$pr_num'"

# GitLab ai-review / ai MR pickup requires assignee_id of the connected user.
gitlab_api() {
    local method="$1"
    local path="$2"
    shift 2
    printf '%s %s\n' "$method" "$path" >> "$GITLAB_API_LOG"
    case "$path" in
        /user)
            printf '{"id":42,"username":"ai-bot"}'
            ;;
        /projects/*/merge_requests\?*)
            if [[ "$path" == *labels=ai-review* && "$path" == *assignee_id=42* ]]; then
                printf '[{"iid":9,"created_at":"2026-01-01T00:00:00Z"}]'
            elif [[ "$path" == *labels=ai-review* ]]; then
                printf '[]'
            elif [[ "$path" == *labels=ai* && "$path" == *assignee_id=42* ]]; then
                printf '[{"iid":8,"created_at":"2026-01-02T00:00:00Z"}]'
            elif [[ "$path" == *labels=ai* && "$path" != *assignee_id=* ]]; then
                fail "MR pickup must filter by assignee_id: $path"
            else
                printf '[]'
            fi
            ;;
        *)
            printf '{}'
            ;;
    esac
}
: > "$GITLAB_API_LOG"
mr_iid="$(gitlab_find_ai_review_mr "group/project")" || fail "gitlab_find_ai_review_mr failed"
[[ "$mr_iid" == "9" ]] || fail "expected MR !9 with ai-review assigned to me, got '$mr_iid'"
grep -q 'assignee_id=42' "$GITLAB_API_LOG" || fail "ai-review MR pickup must filter by assignee_id"
: > "$GITLAB_API_LOG"
mr_iid="$(gitlab_find_ai_mr "group/project")" || fail "gitlab_find_ai_mr failed"
[[ "$mr_iid" == "8" ]] || fail "expected MR !8 with ai assigned to me, got '$mr_iid'"
grep -q 'assignee_id=42' "$GITLAB_API_LOG" || fail "ai MR implement pickup must filter by assignee_id"

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

# Creating an MR for an issue should include ai-pr labels in the payload.
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
        /projects/*/merge_requests)
            printf '{"iid":633,"web_url":"https://gitlab.example.test/g/p/-/merge_requests/633"}'
            ;;
        /projects/*/merge_requests\?*)
            printf '[{"iid":633,"source_branch":"ai/issue-9"},{"iid":634,"source_branch":"feat/human"}]'
            ;;
        /projects/*/merge_requests/*)
            printf '{}'
            ;;
        *)
            printf '{}'
            ;;
    esac
}

: > "$GITLAB_API_LOG"
json="$(gitlab_create_mr "group/project" "ai/issue-9" "main" "Fix #9" "body" "ai-pr")" \
    || fail "gitlab_create_mr failed"
[[ "$(jq -r '.iid' <<<"$json")" == "633" ]] || fail "create mr response"
grep -Eq '"labels"[[:space:]]*:[[:space:]]*"ai-pr"' "$GITLAB_API_LOG" \
    || fail "create mr missing ai-pr labels"

: > "$GITLAB_API_LOG"
gitlab_label_open_issue_mrs_ai_pr "group/project" "9" >/dev/null
grep -q 'PUT /projects/.*/merge_requests/633' "$GITLAB_API_LOG" \
    || fail "expected ai-pr label PUT on MR !633"
grep -Eq '"add_labels"[[:space:]]*:[[:space:]]*"ai-pr"' "$GITLAB_API_LOG" \
    || fail "expected add_labels ai-pr on MR"
if grep -q 'merge_requests/634' "$GITLAB_API_LOG"; then
    fail "must not label unrelated human MR"
fi

echo "assignee-filter tests passed"
