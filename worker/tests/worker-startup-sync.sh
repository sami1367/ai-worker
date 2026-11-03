#!/usr/bin/env bash
# Exercise the real startup sync against a persistent account fixture.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
command -v rsync >/dev/null || { echo 'SKIP: rsync unavailable'; exit 0; }
SRC="$TMP/image"
export AI_WORKER_BASE_DIR="$TMP/config" WORKSPACE_ROOT="$TMP/workspaces"
mkdir -p "$SRC/lib" "$AI_WORKER_BASE_DIR/codex-account"
printf 'image script\n' > "$SRC/lib/current.sh"
printf 'old script\n' > "$AI_WORKER_BASE_DIR/obsolete.sh"
printf 'account fixture\n' > "$AI_WORKER_BASE_DIR/codex-account/auth.json"
printf 'export AI_CODEX_AUTH_MODE=chatgpt\n' > "$AI_WORKER_BASE_DIR/provider-credentials.env"
# Run the entrypoint's sync section, substituting only the immutable image path.
sed '/^# Ensure empty conf arrays/,$d' "$ROOT/scripts/worker-entrypoint.sh" \
  | sed '/^SRC=/d' > "$TMP/sync.sh"
source "$TMP/sync.sh"
grep -q 'account fixture' "$DEST/codex-account/auth.json"
grep -q 'AI_CODEX_AUTH_MODE=chatgpt' "$DEST/provider-credentials.env"
[[ -f "$DEST/lib/current.sh" && ! -e "$DEST/obsolete.sh" ]]
# A second startup must preserve the same credentials too.
source "$TMP/sync.sh"
grep -q 'account fixture' "$DEST/codex-account/auth.json"
echo 'PASS: worker startup preserves Codex login while replacing image scripts'
