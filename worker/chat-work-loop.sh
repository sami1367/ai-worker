#!/usr/bin/env bash
# Durable local-chat queue consumer. Run beside worker.sh under platform-wrapper.sh.
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${AI_WORKER_BASE_DIR:-$SCRIPT_DIR}"
WEB_INTERNAL_URL="${WEB_INTERNAL_URL:-http://web:3000}"
: "${WORKER_INTERNAL_TOKEN:?WORKER_INTERNAL_TOKEN is required}"
worker_id="chat-$(hostname)-$$"
active_id=""
lease_token=""
agent_pid=""
heartbeat_pid=""
mkdir -p "$BASE_DIR/state"
api() {
  local path="$1" body="$2" timeout="${3:-30}"
  curl -fsS --connect-timeout 5 --max-time "$timeout" -X POST \
    -H 'Content-Type: application/json' -H "x-worker-token: $WORKER_INTERNAL_TOKEN" \
    --data-binary "$body" "$WEB_INTERNAL_URL/api/v1/worker/internal/chat-work/$path"
}
kill_agent() {
  if [[ -n "$agent_pid" ]]; then
    # The Node supervisor terminates the entire detached agent process group.
    kill -TERM "$agent_pid" 2>/dev/null || true
    wait "$agent_pid" 2>/dev/null || true
  fi
}
cleanup() {
  kill_agent
  [[ -z "$heartbeat_pid" ]] || kill "$heartbeat_pid" 2>/dev/null || true
  if [[ -n "$active_id" ]]; then api "$active_id/complete" "$(jq -nc --arg leaseToken "$lease_token" '{leaseToken:$leaseToken,exitCode:143}')" >/dev/null 2>&1 || true; fi
  exit 0
}
trap cleanup TERM INT
while true; do
  claim="$(api claim "$(jq -nc --arg workerId "$worker_id" '{workerId:$workerId}')")" || { sleep 5; continue; }
  active_id="$(jq -r '.run.id // empty' <<<"$claim")"
  if [[ -z "$active_id" ]]; then sleep 5; continue; fi
  lease_token="$(jq -er '.run.leaseToken' <<<"$claim")"
  lease_body="$(jq -nc --arg leaseToken "$lease_token" '{leaseToken:$leaseToken}')"
  pid_file="$BASE_DIR/state/chat-work-$active_id.pid"
  (
    failures=0
    while sleep 15; do
      if api "$active_id/heartbeat" "$lease_body" >/dev/null; then failures=0; else failures=$((failures + 1)); fi
      if [[ "$failures" -ge 3 ]]; then
        if [[ -f "$pid_file" ]]; then
          lost_pid="$(cat "$pid_file")"
          [[ "$lost_pid" =~ ^[0-9]+$ ]] && kill -TERM "$lost_pid" 2>/dev/null || true
        fi
        exit 1
      fi
    done
  ) &
  heartbeat_pid=$!
  spec="$BASE_DIR/state/chat-work-$active_id.json"
  if api "$active_id/prepare" "$lease_body" 600 >"$spec"; then
    exit_code=0
    if [[ "$(jq -r '.publishOnly' "$spec")" != "true" ]]; then
      # Bound agent lifetime; failed implementations never publish. Env override is deployment-only.
      node "$SCRIPT_DIR/chat-work-agent.mjs" "$spec" &
      agent_pid=$!
      printf '%s\n' "$agent_pid" >"$pid_file"
      wait "$agent_pid" || exit_code=$?
      agent_pid=""
      rm -f "$pid_file"
    fi
    complete_body="$(jq -nc --arg leaseToken "$lease_token" --argjson exitCode "$exit_code" '{leaseToken:$leaseToken,exitCode:$exitCode}')"
    # A failed callback is retried while the same lease is active. Publication is idempotent.
    for attempt in 1 2 3; do
      api "$active_id/complete" "$complete_body" >/dev/null && break
      sleep 3
    done
  fi
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true
  heartbeat_pid=""
  active_id=""
  rm -f "$spec" "$pid_file"
  sleep 1
done
