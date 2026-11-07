#!/usr/bin/env bash
# Only executes the coding phase. The web orchestrator owns Git and forge publishing.
set -Eeuo pipefail
umask 077
SPEC="${1:?Usage: run-chat-work.sh <prepared-spec.json>}"
WORKER_CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${AI_WORKER_BASE_DIR:-$WORKER_CODE_DIR}"
export WORKER_CODE_DIR BASE_DIR
source "$WORKER_CODE_DIR/lib/common.sh"
source "$WORKER_CODE_DIR/lib/ai.sh"
ai_load_env "$BASE_DIR/.env"
# No forge credential materialization or global Git helper setup in the coding phase.
for credentials in "$BASE_DIR/provider-credentials.env" "$BASE_DIR/worker-runtime.env"; do
  if [[ -f "$credentials" ]]; then set -a; source "$credentials"; set +a; fi
done
AI_PROVIDER="$(jq -er '.provider' "$SPEC")"
workspace="$(jq -er '.workspace' "$SPEC")"
prompt="$(jq -er '.promptFile' "$SPEC")"
stdout_log="$(jq -er '.stdoutLog' "$SPEC")"
stderr_log="$(jq -er '.stderrLog' "$SPEC")"
runner_log="$(jq -er '.runnerLog' "$SPEC")"
exec > >(tee -a "$runner_log") 2>&1
export AI_PROVIDER
export AI_CHAT_WORK_PROTECT_GIT=1
# Group roots deliberately contain sibling Git repositories rather than one root repository.
export AI_CODEX_EXTRA_ARGS="${AI_CODEX_EXTRA_ARGS:-} --skip-git-repo-check"
export CODEGRAPH_ENABLED="$(jq -r 'if .codegraphEnabled then "1" else "0" end' "$SPEC")"
ai_init
ai_run_agent "$workspace" "$prompt" "$stdout_log" "$stderr_log" implement
