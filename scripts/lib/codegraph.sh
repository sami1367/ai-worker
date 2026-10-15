#!/usr/bin/env bash
# CodeGraph system install helpers for the AI Worker container/host.
# Sourced by worker-entrypoint.sh (and usable standalone).

# Log with the ***** prefix required for CodeGraph worker diagnostics.
ai_codegraph_log() {
  printf '***** %s\n' "$*"
}

# Submit admin email to the CodeGraph Pro waitlist (non-interactive path).
# `codegraph install --yes` skips the interactive email prompt, so we mirror
# that signup here using the email collected at first-admin bootstrap.
ai_codegraph_submit_waitlist_email() {
  local email="${1:-${CODEGRAPH_EMAIL:-}}"
  local state_dir="${CODEGRAPH_STATE_DIR:-${HOME}/.codegraph}"
  local choice_file="$state_dir/beta-signup.json"
  local ok=0

  email="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ -n "$email" && "$email" == *@*.* ]] || return 0

  if [[ -f "$choice_file" ]]; then
    if grep -Eq '"status"[[:space:]]*:[[:space:]]*"(subscribed|declined)"' "$choice_file" 2>/dev/null; then
      ai_codegraph_log "CodeGraph waitlist already recorded — skip email submit"
      return 0
    fi
  fi

  ai_codegraph_log "CodeGraph waitlist: submitting email for admin"
  mkdir -p "$state_dir"
  if curl -fsS -X POST \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg email "$email" '{email:$email, source:"ai-worker-bootstrap"}')" \
    --max-time 8 \
    'https://getcodegraph.com/api/waitlist' >/dev/null 2>&1; then
    ok=1
  fi

  if [[ "$ok" -eq 1 ]]; then
    jq -n --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
      '{status:"subscribed", updated_at:$ts}' >"$choice_file"
    ai_codegraph_log "CodeGraph waitlist: subscribed"
  else
    ai_codegraph_log "CodeGraph waitlist: submit failed (will retry on next worker start)"
  fi
  return 0
}

# Ensure CodeGraph CLI is present and wire MCP into all supported agents.
# Non-interactive: --yes --target=all --location=global.
ai_codegraph_ensure_system() {
  local marker="${CODEGRAPH_STATE_DIR:-${HOME}/.codegraph}/ai-worker-agents-installed"
  local email="${CODEGRAPH_EMAIL:-}"

  ai_codegraph_log "CodeGraph: ensuring CLI and agent MCP wiring"

  if ! command -v codegraph >/dev/null 2>&1; then
    ai_codegraph_log "CodeGraph: CLI missing — installing via install.sh"
    curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh || {
      ai_codegraph_log "CodeGraph: CLI install failed"
      return 1
    }
    export PATH="${HOME}/.local/bin:${PATH}"
  fi

  if ! command -v codegraph >/dev/null 2>&1; then
    ai_codegraph_log "CodeGraph: CLI still not on PATH after install"
    return 1
  fi

  ai_codegraph_log "CodeGraph: CLI $(codegraph --version 2>/dev/null || echo present) at $(command -v codegraph)"

  # Re-run install when marker missing or CODEGRAPH_FORCE_INSTALL=1.
  if [[ ! -f "$marker" || "${CODEGRAPH_FORCE_INSTALL:-0}" == "1" ]]; then
    ai_codegraph_log "CodeGraph: running codegraph install -y -t all -l global"
    if codegraph install -y -t all -l global; then
      mkdir -p "$(dirname "$marker")"
      date -u '+%Y-%m-%dT%H:%M:%SZ' >"$marker"
      ai_codegraph_log "CodeGraph: agent MCP install completed (all targets, global)"
    else
      ai_codegraph_log "CodeGraph: agent MCP install failed (non-fatal; will retry next start)"
    fi
  else
    ai_codegraph_log "CodeGraph: agent MCP already configured (marker present)"
  fi

  if [[ -n "$email" ]]; then
    ai_codegraph_submit_waitlist_email "$email"
  else
    ai_codegraph_log "CodeGraph: no CODEGRAPH_EMAIL yet — waitlist submit deferred until admin bootstrap"
  fi

  return 0
}
