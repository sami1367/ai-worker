#!/usr/bin/env bash
# Exercises related-task matching and markdown output without calling GitHub or GitLab.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export BASE_DIR="$TMP/worker"
export AI_RELATED_TASKS_DRY_RUN=1
mkdir -p "$BASE_DIR"

git_repo() {
    local dir="$1"
    mkdir -p "$dir"
    git -C "$dir" init -q
}

git_repo "$TMP/api"
git_repo "$TMP/billing"
git_repo "$TMP/bale"

cat > "$BASE_DIR/github-projects.conf" <<EOF
[
  {
    "name": "api",
    "path": "$TMP/api",
    "block_on_open_pr": true
  },
  {
    "name": "billing",
    "path": "$TMP/billing",
    "block_on_open_pr": false
  }
]
EOF

cat > "$BASE_DIR/gitlab-projects.conf" <<EOF
[
  {
    "name": "bale-service",
    "path": "$TMP/bale",
    "block_on_open_pr": false
  }
]
EOF

# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"
# shellcheck source=../lib/related-tasks.sh
source "$ROOT/lib/related-tasks.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# Case-insensitive name, GitLab list, and org/name fallback.
found="$(ai_lookup_registered_project "BILLING")" || fail "lookup BILLING"
[[ "$(jq -r '.forge' <<<"$found")" == "github" ]] || fail "billing forge"
[[ "$(jq -r '.name' <<<"$found")" == "billing" ]] || fail "billing canonical name"

found="$(ai_lookup_registered_project "org/bale-service")" || fail "lookup basename"
[[ "$(jq -r '.forge' <<<"$found")" == "gitlab" ]] || fail "gitlab forge"

# JSON option parsing (GitHub + GitLab).
billing_entry="$(ai_resolve_project_entry "$BASE_DIR/github-projects.conf" "billing")" \
    || fail "resolve billing entry"
[[ "$(ai_project_entry_bool "$billing_entry" "block_on_open_pr" 1)" == "0" ]] \
    || fail "billing should disable block_on_open_pr"

api_entry="$(ai_resolve_project_entry "$BASE_DIR/github-projects.conf" "api")" \
    || fail "resolve api entry"
[[ "$(ai_project_entry_bool "$api_entry" "block_on_open_pr" 1)" == "1" ]] \
    || fail "api should keep block_on_open_pr enabled"

bale_entry="$(ai_resolve_project_entry "$BASE_DIR/gitlab-projects.conf" "bale-service")" \
    || fail "resolve bale-service entry"
[[ "$(ai_project_entry_bool "$bale_entry" "block_on_open_pr" 1)" == "0" ]] \
    || fail "bale-service should disable block_on_open_pr"

if ai_lookup_registered_project "missing-service" >/dev/null; then
    fail "unknown project should not match"
fi

export PROJECT_DIR="$TMP/api"
NOTES_SAVED="$TMP/notes.md"
printf '%s\n' "existing notes" > "$NOTES_SAVED"

cat > "$TMP/tasks.json" <<'EOF'
{
  "tasks": [
    {
      "project": "billing",
      "title": "Accept the new invoice event",
      "summary": "Handle invoice.created from the API.",
      "why": "README says billing consumes invoice events.",
      "doc": "README.md",
      "acceptance": ["Handler accepts invoice.created"]
    },
    {
      "project": "api",
      "title": "Do not file this on the source repo",
      "summary": "skip",
      "why": "self",
      "doc": "README.md",
      "acceptance": []
    },
    {
      "project": "unknown-service",
      "title": "Document the unmatched service",
      "summary": "No clone registered.",
      "why": "Docs mention it.",
      "doc": "docs/arch.md",
      "acceptance": []
    }
  ]
}
EOF

ai_apply_related_tasks \
    "$TMP/tasks.json" \
    "api" \
    "GitHub issue #4 (https://example.invalid/api/issues/4)" \
    "Implement invoices" || fail "apply returned non-zero"

shopt -s nullglob
files=("$PROJECT_DIR"/tasks/*.md)
[[ "${#files[@]}" -eq 2 ]] || fail "expected 2 markdown files, got ${#files[@]}"

billing_file="$(printf '%s\n' "${files[@]}" | grep billing || true)"
[[ -n "$billing_file" ]] || fail "missing billing markdown"
grep -q 'https://example.invalid/github/billing/issues/dry-run' "$billing_file" || fail "dry-run issue URL missing"
grep -q 'GitHub issue #4' "$billing_file" || fail "source reference missing"
grep -q 'Label: `ai`' "$billing_file" || fail "ai label missing from markdown"
grep -q 'invoice.created' "$billing_file" || fail "acceptance missing"

unknown_file="$(printf '%s\n' "${files[@]}" | grep unknown-service || true)"
[[ -n "$unknown_file" ]] || fail "missing unknown-service markdown"
grep -q 'not created' "$unknown_file" || fail "unknown project should say issue was not created"
grep -q 'not listed' "$unknown_file" || fail "unknown reason missing"

grep -q '## Related services' "$NOTES_SAVED" || fail "notes were not updated"
grep -q 'billing' "$NOTES_SAVED" || fail "notes missing billing"
grep -q 'not filed' "$NOTES_SAVED" || fail "notes missing unfiled task"

# Follow-up issues must not fan out again.
rm -rf "$PROJECT_DIR/tasks"
: > "$NOTES_SAVED"
ai_apply_related_tasks \
    "$TMP/tasks.json" \
    "api" \
    "follow-up" \
    "<!-- ai-worker-related-task --> already filed" || fail "follow-up apply failed"
if compgen -G "$PROJECT_DIR/tasks/*.md" >/dev/null; then
    fail "follow-up run should not write task files"
fi

# Invalid JSON is a warning, not a failure.
echo 'not-json' > "$TMP/bad.json"
ai_apply_related_tasks "$TMP/bad.json" "api" "src" "body" || fail "bad json should return 0"

# Capture removes the in-repo artifact.
printf '%s\n' '{"tasks":[]}' > "$PROJECT_DIR/.ai-related-tasks.json"
ai_capture_related_tasks_file \
    "$PROJECT_DIR/.ai-related-tasks.json" \
    "$TMP/saved.json" || fail "capture failed"
[[ ! -e "$PROJECT_DIR/.ai-related-tasks.json" ]] || fail "artifact was not removed"
grep -q 'tasks' "$TMP/saved.json" || fail "saved copy missing"

echo "related-tasks tests passed"
