#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/workspace" "$TMP/account"
printf '%s\n' 'test prompt' > "$TMP/prompt"
printf '%s\n' '{}' > "$TMP/account/auth.json"
cat > "$TMP/codex" <<'BIN'
#!/usr/bin/env bash
printf 'API=%s\nOPENAI=%s\nACCESS=%s\nHOME=%s\n' "${CODEX_API_KEY-}" "${OPENAI_API_KEY-}" "${CODEX_ACCESS_TOKEN-}" "${CODEX_HOME-}"
printf 'ARG=%s\n' "$@"
BIN
chmod +x "$TMP/codex"
source "$ROOT/worker/lib/ai/codex.sh"
ai_isolation_resolved_mode() { echo env; }
ai_provider_nested_sandbox_blocked() { return 1; }
ai_isolation_exec() { shift 2; "$@"; }
AI_PROVIDER_BIN="$TMP/codex"
export OPENAI_API_KEY='test-api' CODEX_API_KEY='test-codex-api' CODEX_ACCESS_TOKEN='test-access'
export AI_CODEX_ACCOUNT_HOME="$TMP/account"
export AI_CODEX_AUTH_MODE=chatgpt
ai_codex_run "$TMP/workspace" "$TMP/prompt" "$TMP/chatgpt.log" "$TMP/stderr" >/dev/null
grep -q '^API=$' "$TMP/chatgpt.log"
grep -q '^OPENAI=$' "$TMP/chatgpt.log"
grep -q '^ACCESS=$' "$TMP/chatgpt.log"
grep -q -F "HOME=$TMP/account" "$TMP/chatgpt.log"
grep -q '^ARG=forced_login_method="chatgpt"$' "$TMP/chatgpt.log"
[[ "$OPENAI_API_KEY" == test-api && "$CODEX_API_KEY" == test-codex-api ]]
export AI_CODEX_AUTH_MODE=api
ai_codex_run "$TMP/workspace" "$TMP/prompt" "$TMP/api.log" "$TMP/stderr" >/dev/null
grep -q '^API=test-codex-api$' "$TMP/api.log"
grep -q '^ARG=forced_login_method="api"$' "$TMP/api.log"
unset OPENAI_API_KEY CODEX_API_KEY
if ai_codex_run "$TMP/workspace" "$TMP/prompt" "$TMP/no-key.log" "$TMP/stderr" 2>/dev/null; then
    echo 'FAIL: API mode fell back to a cached account' >&2
    exit 1
fi
export AI_CODEX_AUTH_MODE=invalid
if ai_codex_run "$TMP/workspace" "$TMP/prompt" "$TMP/invalid.log" "$TMP/stderr" 2>/dev/null; then
    echo 'FAIL: Invalid auth mode accepted' >&2
    exit 1
fi
printf '%s\n' 'PASS: Codex authentication selection and credential isolation'
