#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
loop_pid=""
cleanup() {
  if [[ -n "$loop_pid" ]]; then kill -TERM "$loop_pid" 2>/dev/null || true; wait "$loop_pid" 2>/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir -p "$fixture/bin" "$fixture/runtime/state" "$fixture/workspace/api" "$fixture/artifacts"
cat >"$fixture/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
body=""
while [[ $# -gt 0 ]]; do
  case "$1" in --data-binary) body="$2"; shift 2;; *) url="$1"; shift;; esac
done
case "$url" in
  */claim)
    if [[ -f "$FIXTURE/claimed" ]]; then touch "$FIXTURE/idle"; printf '{"run":null}'; else touch "$FIXTURE/claimed"; printf '{"run":{"id":"test-run","leaseToken":"test-token"}}'; fi;;
  */prepare) cat "$FIXTURE/spec.json";;
  */complete) printf '%s\n' "$body" >>"$FIXTURE/completed"; printf '{"status":"publishing"}';;
  */heartbeat) printf '{"ok":true}';;
  *) exit 22;;
esac
STUB
cat >"$fixture/bin/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${GH_TOKEN:-}" && -z "${GITLAB_TOKEN:-}" && -z "${WORKER_INTERNAL_TOKEN:-}" ]] || exit 71
[[ "$*" == *"--skip-git-repo-check"* ]] || exit 72
printf '{"type":"turn.completed","usage":{}}\n'
touch "$FIXTURE/agent-ran"
exit "${TEST_AGENT_EXIT:-0}"
STUB
chmod +x "$fixture/bin/curl" "$fixture/bin/codex"
cat >"$fixture/runtime/.env" <<'ENV'
AI_ISOLATION_MODE=env
AI_CODEX_AUTH_MODE=api
CODEX_API_KEY=test-model-key
ENV
printf 'Implement the approved task.\n' >"$fixture/artifacts/prompt.txt"
export FIXTURE="$fixture" PATH="$fixture/bin:$PATH" AI_WORKER_BASE_DIR="$fixture/runtime" WORKSPACE_ROOT="$fixture/workspace"
export WORKER_INTERNAL_TOKEN=test-token GH_TOKEN=test-forge-token GITLAB_TOKEN=test-gitlab-token
make_spec() {
  jq -nc --arg root "$fixture" --argjson publishOnly "$1" '{workspace:($root+"/workspace"),promptFile:($root+"/artifacts/prompt.txt"),stdoutLog:($root+"/artifacts/agent.ndjson"),stderrLog:($root+"/artifacts/stderr.log"),runnerLog:($root+"/artifacts/runner.log"),provider:"codex",codegraphEnabled:false,publishOnly:$publishOnly}' >"$fixture/spec.json"
}
run_case() {
  local publish_only="$1" expected_exit="$2"
  rm -f "$fixture/claimed" "$fixture/idle" "$fixture/completed" "$fixture/agent-ran"
  make_spec "$publish_only"
  bash "$ROOT/worker/chat-work-loop.sh" >"$fixture/loop.log" 2>&1 &
  loop_pid=$!
  for _ in $(seq 1 200); do [[ ! -f "$fixture/idle" ]] || break; sleep 0.05; done
  if [[ ! -f "$fixture/completed" ]]; then cat "$fixture/loop.log"; echo 'FAIL: worker did not complete a claimed job'; exit 1; fi
  [[ "$(head -1 "$fixture/completed" | jq -r '.exitCode')" == "$expected_exit" ]] || { cat "$fixture/loop.log"; echo 'FAIL: wrong agent result'; exit 1; }
  if [[ "$publish_only" == true ]]; then [[ ! -f "$fixture/agent-ran" ]]; else [[ -f "$fixture/agent-ran" ]]; fi
  kill -TERM "$loop_pid" 2>/dev/null || true; wait "$loop_pid" 2>/dev/null || true; loop_pid=""
}
export TEST_AGENT_EXIT=0
run_case false 0
export TEST_AGENT_EXIT=9
run_case false 9
run_case true 0
printf 'PASS: chat work claim/prepare/agent/complete, failed agents, publish-only retries, and credential isolation\n'
