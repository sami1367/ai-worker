#!/usr/bin/env bash
# Security-boundary tests for AI agent isolation (not prompt-text checks).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=lib/common.sh
source "$ROOT/lib/common.sh"
# shellcheck source=lib/ai.sh
source "$ROOT/lib/ai.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "ok: $*"
}

BASE="$TMP/config"
WS_ROOT="$TMP/workspaces"
WS="$WS_ROOT/assigned"
OTHER="$WS_ROOT/other"
mkdir -p "$BASE/ssh" "$WS" "$OTHER" "$BASE/logs" "$BASE/state"
export AI_WORKER_BASE_DIR="$BASE"
export BASE_DIR="$BASE"
export WORKSPACE_ROOT="$WS_ROOT"

# Materialize privileged host-side secrets (as the real worker does).
cat >"$BASE/forge-credentials.env" <<'EOF'
export GH_TOKEN="test-gh-token-DO-NOT-LEAK"
export GITHUB_TOKEN="test-gh-token-DO-NOT-LEAK"
export GITLAB_TOKEN="test-gl-token-DO-NOT-LEAK"
export GITLAB_HOST="https://gitlab.example.test"
EOF
cat >"$BASE/provider-credentials.env" <<'EOF'
export CURSOR_API_KEY="test-cursor-key"
export ANTHROPIC_API_KEY="test-anthropic-key"
export ANTHROPIC_CUSTOM_HEADERS="anthropic-workspace-id: wrkspc_test"
export OPENAI_API_KEY="test-openai-key"
export CODEX_API_KEY="test-openai-key"
export GEMINI_API_KEY="test-gemini-key"
export COPILOT_GITHUB_TOKEN="test-copilot-token"
EOF
cat >"$BASE/app-secrets.env" <<'EOF'
SECRET_ENCRYPTION_KEY=deadbeef
WORKER_INTERNAL_TOKEN=wit-secret
NUXT_SESSION_PASSWORD=session-secret
EOF
printf 'HOST_DOTENV=1\n' >"$BASE/.env"
printf 'SSHPRIVATEKEY\n' >"$BASE/ssh/id_ed25519"
chmod 600 "$BASE/ssh/id_ed25519"

export GH_TOKEN="test-gh-token-DO-NOT-LEAK"
export GITHUB_TOKEN="test-gh-token-DO-NOT-LEAK"
export GITLAB_TOKEN="test-gl-token-DO-NOT-LEAK"
export GITLAB_HOST="https://gitlab.example.test"
export GIT_SSH_COMMAND="ssh -i $BASE/ssh/id_ed25519"
export CURSOR_API_KEY="test-cursor-key"
export ANTHROPIC_API_KEY="test-anthropic-key"
export ANTHROPIC_CUSTOM_HEADERS="anthropic-workspace-id: wrkspc_test"
export OPENAI_API_KEY="test-openai-key"
export CODEX_API_KEY="test-openai-key"
export GEMINI_API_KEY="test-gemini-key"
export COPILOT_GITHUB_TOKEN="test-copilot-token"
export WORKER_INTERNAL_TOKEN="wit-secret"
export SECRET_ENCRYPTION_KEY="deadbeef"
export DATABASE_URL="postgres://aiworker:pw@db/aiworker"
export NUXT_SESSION_PASSWORD="session-secret"

# ----- 1–5: agent process boundary (bwrap or env) -----

PROBE_OUT="$TMP/probe.out"
AI_ISOLATION_MODE="${AI_ISOLATION_MODE:-auto}"
MODE="$(ai_isolation_resolved_mode)" || fail "resolve isolation mode"
pass "isolation mode resolves to $MODE"

ai_isolation_exec "$WS" -- bash -c '
set -euo pipefail
report() { printf "%s=%s\n" "$1" "$2"; }

# 1. No forge write tokens
report GH_TOKEN "${GH_TOKEN-}"
report GITHUB_TOKEN "${GITHUB_TOKEN-}"
report GITLAB_TOKEN "${GITLAB_TOKEN-}"

# 2. No privileged host / app secrets
report WORKER_INTERNAL_TOKEN "${WORKER_INTERNAL_TOKEN-}"
report SECRET_ENCRYPTION_KEY "${SECRET_ENCRYPTION_KEY-}"
report DATABASE_URL "${DATABASE_URL-}"
report NUXT_SESSION_PASSWORD "${NUXT_SESSION_PASSWORD-}"
report GIT_SSH_COMMAND "${GIT_SSH_COMMAND-}"

# AI keys remain (needed for CLIs)
report CURSOR_API_KEY "${CURSOR_API_KEY-}"
report ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY-}"
report ANTHROPIC_CUSTOM_HEADERS "${ANTHROPIC_CUSTOM_HEADERS-}"
report OPENAI_API_KEY "${OPENAI_API_KEY-}"
report CODEX_API_KEY "${CODEX_API_KEY-}"
report GEMINI_API_KEY "${GEMINI_API_KEY-}"
report COPILOT_GITHUB_TOKEN "${COPILOT_GITHUB_TOKEN-}"

# Credential files
forge_bytes=$(wc -c < "'"$BASE"'/forge-credentials.env" 2>/dev/null || echo missing)
app_bytes=$(wc -c < "'"$BASE"'/app-secrets.env" 2>/dev/null || echo missing)
dotenv_bytes=$(wc -c < "'"$BASE"'/.env" 2>/dev/null || echo missing)
report forge_bytes "$forge_bytes"
report app_bytes "$app_bytes"
report dotenv_bytes "$dotenv_bytes"

ssh_listing=$(ls -A "'"$BASE"'/ssh" 2>/dev/null | tr "\n" "," || true)
report ssh_listing "$ssh_listing"

# 5. Workspace write OK; sibling / config write blocked when bwrap confines
echo agent-write > "'"$WS"'/agent.txt"
report workspace_write ok
if echo leak > "'"$OTHER"'/leak.txt" 2>/dev/null; then
  report sibling_write ok
else
  report sibling_write blocked
fi
if echo leak > "'"$BASE"'/pwned.txt" 2>/dev/null; then
  report config_write ok
else
  report config_write blocked
fi
# (ROFS errors above are expected under bwrap and are not failures)

# 3. Authenticated git push must fail without credentials
git init -q "'"$WS"'"
git -C "'"$WS"'" config user.email "t@example.com"
git -C "'"$WS"'" config user.name "t"
echo x > "'"$WS"'/f"
git -C "'"$WS"'" add f
git -C "'"$WS"'" commit -q -m t
# Fake remote over HTTPS — credential helper must not supply the stripped token
git -C "'"$WS"'" remote add origin "https://gitlab.example.test/group/project.git"
set +e
GIT_TERMINAL_PROMPT=0 git -C "'"$WS"'" push origin HEAD:refs/heads/agent-should-fail 2>"'"$TMP"'/git-push.err"
push_rc=$?
set -e
report git_push_rc "$push_rc"

# 4. Forge API helpers must not see a token
if command -v gh >/dev/null 2>&1; then
  set +e
  GH_TOKEN= GITHUB_TOKEN= gh api user >/dev/null 2>"'"$TMP"'/gh.err"
  gh_rc=$?
  set -e
  report gh_api_rc "$gh_rc"
else
  report gh_api_rc skipped
fi

# curl with Authorization from env must not have the token available
report curl_token_present "${GITLAB_TOKEN:+yes}"
' >"$PROBE_OUT"

# Parse probe
getv() { awk -F= -v k="$1" '$1==k {print substr($0,index($0,"=")+1); exit}' "$PROBE_OUT"; }

[[ -z "$(getv GH_TOKEN)" ]] || fail "agent saw GH_TOKEN"
[[ -z "$(getv GITHUB_TOKEN)" ]] || fail "agent saw GITHUB_TOKEN"
[[ -z "$(getv GITLAB_TOKEN)" ]] || fail "agent saw GITLAB_TOKEN"
pass "1. agent cannot access forge write tokens"

[[ -z "$(getv WORKER_INTERNAL_TOKEN)" ]] || fail "agent saw WORKER_INTERNAL_TOKEN"
[[ -z "$(getv SECRET_ENCRYPTION_KEY)" ]] || fail "agent saw SECRET_ENCRYPTION_KEY"
[[ -z "$(getv DATABASE_URL)" ]] || fail "agent saw DATABASE_URL"
[[ -z "$(getv NUXT_SESSION_PASSWORD)" ]] || fail "agent saw NUXT_SESSION_PASSWORD"
[[ -z "$(getv GIT_SSH_COMMAND)" ]] || fail "agent saw GIT_SSH_COMMAND"
pass "2a. agent cannot access privileged host env secrets"

if [[ "$MODE" == "bwrap" ]]; then
    [[ "$(getv forge_bytes)" == "0" ]] || fail "forge-credentials.env readable (bytes=$(getv forge_bytes))"
    [[ "$(getv app_bytes)" == "0" ]] || fail "app-secrets.env readable"
    [[ "$(getv dotenv_bytes)" == "0" ]] || fail ".env readable"
    [[ -z "$(getv ssh_listing)" ]] || fail "ssh dir not empty in sandbox: $(getv ssh_listing)"
    pass "2b. agent cannot read publishing credential files / SSH keys (bwrap)"
else
    echo "LIMITATION: mode=$MODE — credential files remain readable on disk; env scrub only."
    pass "2b. skipped file overlays (no bwrap); limitation documented"
fi

[[ "$(getv CURSOR_API_KEY)" == "test-cursor-key" ]] || fail "CURSOR_API_KEY not passed through"
[[ "$(getv ANTHROPIC_API_KEY)" == "test-anthropic-key" ]] || fail "ANTHROPIC_API_KEY not passed through"
[[ "$(getv ANTHROPIC_CUSTOM_HEADERS)" == "anthropic-workspace-id: wrkspc_test" ]] || fail "ANTHROPIC_CUSTOM_HEADERS not passed through"
[[ "$(getv OPENAI_API_KEY)" == "test-openai-key" ]] || fail "OPENAI_API_KEY not passed through"
[[ "$(getv CODEX_API_KEY)" == "test-openai-key" ]] || fail "CODEX_API_KEY not passed through"
[[ "$(getv GEMINI_API_KEY)" == "test-gemini-key" ]] || fail "GEMINI_API_KEY not passed through"
[[ "$(getv COPILOT_GITHUB_TOKEN)" == "test-copilot-token" ]] || fail "COPILOT_GITHUB_TOKEN not passed through"
pass "AI provider keys remain available to the agent"

[[ "$(getv git_push_rc)" != "0" ]] || fail "git push unexpectedly succeeded inside agent"
pass "3. agent cannot authenticate a git push"

[[ "$(getv curl_token_present)" != "yes" ]] || fail "GITLAB_TOKEN still set for curl"
gh_rc="$(getv gh_api_rc)"
if [[ "$gh_rc" != "skipped" && "$gh_rc" == "0" ]]; then
    fail "gh api succeeded without token (unexpected)"
fi
pass "4. agent cannot call authenticated forge APIs with worker tokens"

[[ -f "$WS/agent.txt" ]] || fail "workspace write failed"
if [[ "$MODE" == "bwrap" ]]; then
    [[ "$(getv sibling_write)" == "blocked" ]] || fail "sibling workspace writable"
    [[ "$(getv config_write)" == "blocked" ]] || fail "config dir writable"
    [[ ! -f "$OTHER/leak.txt" ]] || fail "sibling leak file exists"
    pass "5. agent confined to assigned workspace (bwrap)"
else
    echo "LIMITATION: mode=$MODE — filesystem confinement requires bubblewrap."
    pass "5. workspace writable; confinement limitation documented"
fi

# Host secrets must remain intact for orchestration after agent exits.
grep -q 'test-gh-token-DO-NOT-LEAK' "$BASE/forge-credentials.env" || fail "host forge creds corrupted"
grep -q 'SSHPRIVATEKEY' "$BASE/ssh/id_ed25519" || fail "host ssh key corrupted"
[[ "$GH_TOKEN" == "test-gh-token-DO-NOT-LEAK" ]] || fail "parent lost GH_TOKEN"
[[ "$GITLAB_TOKEN" == "test-gl-token-DO-NOT-LEAK" ]] || fail "parent lost GITLAB_TOKEN"
pass "6a. parent orchestration still holds forge credentials after agent"

# Simulate trusted publish phase: local commit + push to a local bare remote (no forge network).
BARE="$TMP/bare.git"
git init -q --bare "$BARE"
PUB="$TMP/publish-ws"
git init -q "$PUB"
git -C "$PUB" config user.email "orch@example.com"
git -C "$PUB" config user.name "orch"
echo published >"$PUB/file.txt"
git -C "$PUB" add file.txt
git -C "$PUB" commit -q -m "orchestration publish"
git -C "$PUB" remote add origin "$BARE"
git -C "$PUB" push -q origin HEAD:refs/heads/main
git --git-dir="$BARE" rev-parse refs/heads/main >/dev/null
pass "6b. trusted publishing phase can commit and push"

# ----- 7. no-change rejects unauthorized modifications -----
NC="$TMP/no-change-ws"
git init -q "$NC"
git -C "$NC" config user.email "t@example.com"
git -C "$NC" config user.name "t"
echo base >"$NC/README"
git -C "$NC" add README
git -C "$NC" commit -q -m base
echo answer >"$NC/.ai-issue-answer.md"
echo hack >"$NC/README"
if ai_assert_only_allowed_changes "$NC" ".ai-issue-answer.md"; then
    fail "no-change should reject README edits"
fi
pass "7. no-change workflow rejects unauthorized code modifications"

# Clean product tree with only answer artifact should pass.
git -C "$NC" checkout -- README
ai_assert_only_allowed_changes "$NC" ".ai-issue-answer.md" || fail "allowed answer artifact rejected"
pass "7b. answer artifact alone is allowed"

# ----- 8. review allowlist -----
rm -f "$NC/.ai-issue-answer.md"
echo review >"$NC/.ai-pr-review.md"
echo hack >"$NC/src.c"
if ai_assert_only_allowed_changes "$NC" ".ai-pr-review.md"; then
    fail "review should reject src.c edits"
fi
rm -f "$NC/src.c"
ai_assert_only_allowed_changes "$NC" ".ai-pr-review.md" || fail "review artifact rejected"
pass "8. review/answer-only workflows reject implementation file changes"

# Untracked dirs (git porcelain "?? .codegraph/") must not crash on empty basename.
mkdir -p "$NC/.codegraph"
touch "$NC/.codegraph/.gitignore"
if ai_assert_only_allowed_changes "$NC" ".ai-pr-review.md"; then
    fail "untracked tooling dir should be rejected"
fi
rm -rf "$NC/.codegraph"
ai_assert_only_allowed_changes "$NC" ".ai-pr-review.md" || fail "review artifact rejected after dir cleanup"
pass "8b. untracked directory paths do not trigger bad array subscript"

# ----- 9. failure cleanup does not leak credentials into logs we emit -----
# Ensure our phase logger never prints token values.
LOG_SNIP="$TMP/phase.log"
ai_log_phase "AGENT" "probe" >"$LOG_SNIP"
if grep -E 'test-gh-token|test-gl-token|wit-secret|deadbeef|SSHPRIVATEKEY' "$LOG_SNIP"; then
    fail "phase log leaked a secret"
fi
# Interrupted-job simulation: discard local changes leaves host secrets alone.
ai_discard_local_changes "$NC" || true
grep -q 'test-gh-token-DO-NOT-LEAK' "$BASE/forge-credentials.env" || fail "creds lost after discard"
pass "9. failures/cleanup do not leak or wipe host publishing credentials"

# ----- 10. forge text validation + path helper -----
BODY="$TMP/body.md"
printf 'hello review\n' >"$BODY"
ai_validate_forge_text_file "$BODY" 100 0 || fail "valid body rejected"
printf '' >"$BODY"
if ai_validate_forge_text_file "$BODY" 100 0; then
    fail "empty body accepted"
fi
# NUL rejection
printf 'a\0b' >"$BODY"
if ai_validate_forge_text_file "$BODY" 100 0; then
    fail "NUL body accepted"
fi
ai_path_inside_root "$WS" "$WS/agent.txt" || fail "path inside root failed"
if ai_path_inside_root "$WS" "$OTHER/x"; then
    fail "path outside root accepted"
fi
pass "10. forge text / path validation helpers work"

# Env-only mode still strips tokens even without bwrap overlays.
AI_ISOLATION_MODE=env
# Reset probe cache between mode switches.
AI_ISOLATION_BWRAP_USABLE=""
ai_isolation_exec "$WS" -- bash -c '[[ -z "${GH_TOKEN:-}" && -z "${GITLAB_TOKEN:-}" ]]' \
    || fail "env mode failed to strip tokens"
pass "env isolation mode strips forge tokens"

# auto mode must fall back to env when bwrap cannot create namespaces.
# Simulate a broken bwrap binary on PATH (common Docker AppArmor/seccomp case).
FAKE_BIN="$TMP/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/bwrap" <<'EOF'
#!/usr/bin/env bash
echo "bwrap: No permissions to create new namespace" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/bwrap"
AI_ISOLATION_MODE=auto
AI_ISOLATION_BWRAP_USABLE=""
AI_ISOLATION_USERNS_USABLE=""
PATH="$FAKE_BIN:$PATH"
FALLBACK_MODE="$(ai_isolation_resolved_mode 2>/dev/null)" || fail "auto resolve failed with broken bwrap"
[[ "$FALLBACK_MODE" == "env" ]] || fail "auto should fall back to env when bwrap is unusable (got $FALLBACK_MODE)"
pass "auto falls back to env when bubblewrap namespaces are blocked"

# Provider sandboxes must detect the same userns failure (Codex/Cursor fallbacks).
AI_ISOLATION_USERNS_USABLE=""
AI_ISOLATION_BWRAP_USABLE=""
if ai_isolation_userns_usable; then
    fail "userns probe should fail with broken bwrap on PATH"
fi
pass "userns probe reports blocked when bwrap cannot create namespaces"

# Every provider must treat a broken nested namespace as "sandbox blocked".
if ! ai_provider_nested_sandbox_blocked; then
    fail "provider nested sandbox should be blocked when bwrap cannot create namespaces"
fi
pass "provider nested sandbox blocked for all providers when userns fail"

# Claude must force sandbox.enabled=false without calling the real CLI.
STUB="$TMP/stub-claude"
cat >"$STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$STUB_ARGS"
exit 0
EOF
chmod +x "$STUB"
export STUB_ARGS="$TMP/claude.args"
export AI_PROVIDER_BIN="$STUB"
# shellcheck source=lib/ai/claude.sh
source "$ROOT/lib/ai/claude.sh"
AI_ISOLATION_MODE=env
AI_ISOLATION_USERNS_USABLE=""
AI_ISOLATION_BWRAP_USABLE=""
printf 'hello\n' >"$TMP/claude-prompt.txt"
# API key path uses --bare (OAuth is ignored by Claude Code in bare mode).
export ANTHROPIC_API_KEY="test-anthropic-key"
unset CLAUDE_CODE_OAUTH_TOKEN || true
ai_claude_run "$WS" "$TMP/claude-prompt.txt" "$TMP/out.log" "$TMP/err.log" implement >/dev/null
grep -a -F -q '{"sandbox":{"enabled":false}}' "$STUB_ARGS" || fail "claude did not force sandbox.enabled=false"
# Claude Code requires --verbose with -p + --output-format=stream-json
grep -a -Fxq -- '--verbose' "$STUB_ARGS" || fail "claude did not pass --verbose for stream-json"
grep -a -Fxq -- '--bare' "$STUB_ARGS" || fail "claude should pass --bare when ANTHROPIC_API_KEY is set"
pass "claude disables its bubblewrap sandbox when nested namespaces are blocked"

# OAuth-only: omit --bare so Claude Code can read CLAUDE_CODE_OAUTH_TOKEN.
unset ANTHROPIC_API_KEY || true
export CLAUDE_CODE_OAUTH_TOKEN="test-claude-oauth"
: >"$STUB_ARGS"
ai_claude_run "$WS" "$TMP/claude-prompt.txt" "$TMP/out-oauth.log" "$TMP/err-oauth.log" implement >/dev/null 2>"$TMP/claude-oauth.warn"
if grep -a -Fxq -- '--bare' "$STUB_ARGS"; then
    fail "claude must not pass --bare when only CLAUDE_CODE_OAUTH_TOKEN is set"
fi
grep -a -Fxq -- '-p' "$STUB_ARGS" || fail "claude oauth path should still use -p"
pass "claude omits --bare for CLAUDE_CODE_OAUTH_TOKEN auth"

echo
echo "agent-isolation.sh: all checks passed (mode was $MODE for primary probes)"
