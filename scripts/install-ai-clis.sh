#!/usr/bin/env bash
# Install Cursor Agent CLI + Claude Code CLI + Codex CLI + Gemini CLI into the image (or host).
# Intended for Docker build; also usable on a Linux host for local worker runs.
set -Eeuo pipefail

TARGET_HOME="${AI_CLI_HOME:-${HOME:-/home/appuser}}"
export HOME="$TARGET_HOME"
export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"

mkdir -p "${HOME}/.local/bin" "${HOME}/.local/share" "${HOME}/.npm-global"

echo "[install-ai-clis] Installing Claude Code CLI (@anthropic-ai/claude-code)…"
# Always install into the target home so the non-root appuser can execute it.
npm install -g --prefix "${HOME}/.npm-global" @anthropic-ai/claude-code
export PATH="${HOME}/.npm-global/bin:${PATH}"
if [[ -x "${HOME}/.npm-global/bin/claude" ]]; then
  ln -sfn "${HOME}/.npm-global/bin/claude" "${HOME}/.local/bin/claude"
fi
command -v claude >/dev/null
claude --version || true

echo "[install-ai-clis] Installing Codex CLI (@openai/codex)…"
npm install -g --prefix "${HOME}/.npm-global" @openai/codex
if [[ -x "${HOME}/.npm-global/bin/codex" ]]; then
  ln -sfn "${HOME}/.npm-global/bin/codex" "${HOME}/.local/bin/codex"
fi
command -v codex >/dev/null
codex --version || true

echo "[install-ai-clis] Installing Gemini CLI (@google/gemini-cli)…"
npm install -g --prefix "${HOME}/.npm-global" @google/gemini-cli
if [[ -x "${HOME}/.npm-global/bin/gemini" ]]; then
  ln -sfn "${HOME}/.npm-global/bin/gemini" "${HOME}/.local/bin/gemini"
fi
command -v gemini >/dev/null
gemini --version || true

echo "[install-ai-clis] Installing Cursor Agent CLI…"
curl https://cursor.com/install -fsS | bash

# Prefer system-wide symlinks so web + worker find binaries without PATH tweaks.
link_into_usr_local() {
  local src="$1" dest="$2"
  [[ -x "$src" && -w /usr/local/bin ]] || return 0
  ln -sfn "$src" "/usr/local/bin/$dest"
}

link_into_usr_local "${HOME}/.local/bin/agent" agent
if [[ -x "${HOME}/.local/bin/cursor-agent" ]]; then
  link_into_usr_local "${HOME}/.local/bin/cursor-agent" cursor-agent
elif [[ -x "${HOME}/.local/bin/agent" ]]; then
  link_into_usr_local "${HOME}/.local/bin/agent" cursor-agent
fi
if command -v claude >/dev/null 2>&1; then
  link_into_usr_local "$(command -v claude)" claude
fi
if command -v codex >/dev/null 2>&1; then
  link_into_usr_local "$(command -v codex)" codex
fi
if command -v gemini >/dev/null 2>&1; then
  link_into_usr_local "$(command -v gemini)" gemini
fi

if ! command -v agent >/dev/null 2>&1 && ! command -v cursor-agent >/dev/null 2>&1; then
  echo "[install-ai-clis] ERROR: Cursor CLI not found after install (expected agent or cursor-agent)" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "[install-ai-clis] ERROR: Claude Code CLI not found after install" >&2
  exit 1
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "[install-ai-clis] ERROR: Codex CLI not found after install" >&2
  exit 1
fi
if ! command -v gemini >/dev/null 2>&1; then
  echo "[install-ai-clis] ERROR: Gemini CLI not found after install" >&2
  exit 1
fi

agent --version 2>/dev/null || cursor-agent --version 2>/dev/null || true
echo "[install-ai-clis] Done. claude=$(command -v claude) codex=$(command -v codex) gemini=$(command -v gemini) agent=$(command -v agent || true) cursor-agent=$(command -v cursor-agent || true)"
