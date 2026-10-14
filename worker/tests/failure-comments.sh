#!/usr/bin/env bash
# Unit tests for ai-failed comment helpers (no forge network).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

[[ "$(ai_describe_runner_exit_code 20)" == *"no product-file changes"* ]] \
    || fail "exit 20 description"
[[ "$(ai_describe_runner_exit_code 12)" == *"not clean"* ]] \
    || fail "exit 12 description"

cat > "$TMP/run.log" <<'EOF'
Some noise
ERROR:
Cursor completed but made no changes.

============================================================
                     CLEANUP
============================================================
EOF

excerpt="$(ai_extract_log_error_excerpt "$TMP/run.log")"
[[ "$excerpt" == *"Cursor completed but made no changes."* ]] \
    || fail "log excerpt missing ERROR body: $excerpt"

cat > "$TMP/notes.md" <<'EOF'
## Why this was not implemented

Unrelated to this repository — belongs in vibe-plus1-user.
EOF

ai_notes_explain_no_implementation "$TMP/notes.md" \
    || fail "decline notes with Why heading should match"

cat > "$TMP/notes-summary.md" <<'EOF'
## Summary

Unrelated to this repository. No code changes; empty pull request for the record.
EOF

ai_notes_explain_no_implementation "$TMP/notes-summary.md" \
    || fail "decline notes with Summary + unrelated should match"

cat > "$TMP/notes-ok.md" <<'EOF'
## Summary

Repositioned the homepage hero.

## Deployment

None
EOF

if ai_notes_explain_no_implementation "$TMP/notes-ok.md"; then
    fail "successful implement notes must not look like a decline"
fi

body="$(ai_format_failure_comment 20 ai "$TMP/run.log" "$TMP/notes.md")"
[[ "$body" == *"<!-- ai-worker-failure -->"* ]] || fail "missing marker"
[[ "$body" == *"AI Worker failed"* ]] || fail "missing title"
[[ "$body" == *"no product-file changes"* ]] || fail "missing reason"
[[ "$body" == *"Cursor completed but made no changes."* ]] || fail "missing log details"
[[ "$body" == *"vibe-plus1-user"* ]] || fail "missing agent notes"
[[ "$body" == *'`ai`'* ]] || fail "missing retry label"

touch "$TMP/a-old.log"
sleep 0.05
touch "$TMP/a-new.log"
latest="$(ai_latest_glob_match "$TMP/a-*.log")"
[[ "$latest" == "$TMP/a-new.log" ]] || fail "latest glob should pick newest file"

echo "failure-comments tests passed"
