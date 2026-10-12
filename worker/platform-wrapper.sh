#!/usr/bin/env bash
# Platform wrapper around worker.sh:
# - heartbeats to the web API
# - polls control_requests
# - exports env for the Bash worker
# Does not accept arbitrary commands from the network.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AI_WORKER_BASE_DIR="${AI_WORKER_BASE_DIR:-$SCRIPT_DIR}"
BASE_DIR="$AI_WORKER_BASE_DIR"

WEB_INTERNAL_URL="${WEB_INTERNAL_URL:-http://web:3000}"
WORKER_INTERNAL_TOKEN="${WORKER_INTERNAL_TOKEN:-}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-30}"
CONTROL_POLL_INTERVAL="${CONTROL_POLL_INTERVAL:-5}"
APP_VERSION="${APP_VERSION:-1.0.0}"

mkdir -p "$BASE_DIR/logs" "$BASE_DIR/state"
WRAPPER_LOG="$BASE_DIR/logs/platform-wrapper.log"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$*" | tee -a "$WRAPPER_LOG"
}

require_token() {
  if [[ -z "$WORKER_INTERNAL_TOKEN" ]]; then
    log "ERROR: WORKER_INTERNAL_TOKEN is required"
    exit 1
  fi
}

api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -fsS -X "$method" \
      -H "Content-Type: application/json" \
      -H "x-worker-token: $WORKER_INTERNAL_TOKEN" \
      -d "$data" \
      "${WEB_INTERNAL_URL}${path}" || true
  else
    curl -fsS -X "$method" \
      -H "x-worker-token: $WORKER_INTERNAL_TOKEN" \
      "${WEB_INTERNAL_URL}${path}" || true
  fi
}

heartbeat() {
  local status="$1"
  local active="${2:-0}"
  local payload
  payload="$(jq -n \
    --arg status "$status" \
    --arg host "$(hostname 2>/dev/null || echo unknown)" \
    --arg ver "$APP_VERSION" \
    --argjson pid "$$" \
    --argjson active "$active" \
    '{
      status: $status,
      hostname: $host,
      pid: $pid,
      version: $ver,
      activeTaskCount: $active,
      pollSucceeded: true,
      providerAvailability: {}
    }')"
  api POST /api/v1/worker/internal/heartbeat "$payload" >/dev/null
}

WORKER_PID=""
SHOULD_RUN=1
STOP_REQUESTED=0

start_worker() {
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    return 0
  fi
  log "Starting worker.sh"
  (
    # Prefer code next to this wrapper; runtime data via AI_WORKER_BASE_DIR/BASE_DIR
    # Lazy-clone ensure-workspace calls need these.
    export WEB_INTERNAL_URL WORKER_INTERNAL_TOKEN
    exec "$SCRIPT_DIR/worker.sh"
  ) &
  WORKER_PID=$!
  SHOULD_RUN=1
  heartbeat running 0
}

stop_worker_graceful() {
  STOP_REQUESTED=1
  SHOULD_RUN=0
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    log "Sending SIGTERM to worker pid $WORKER_PID"
    kill -TERM "$WORKER_PID" 2>/dev/null || true
    local waited=0
    while kill -0 "$WORKER_PID" 2>/dev/null && [[ $waited -lt 120 ]]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$WORKER_PID" 2>/dev/null; then
      log "Worker still running after grace period; sending SIGKILL"
      kill -KILL "$WORKER_PID" 2>/dev/null || true
    fi
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  WORKER_PID=""
  heartbeat stopped 0
}

handle_control() {
  local json
  json="$(api GET /api/v1/worker/internal/control)"
  [[ -z "$json" || "$json" == "null" ]] && return 0

  local ids
  ids="$(jq -r '.items[]?.id // empty' <<<"$json" 2>/dev/null || true)"
  [[ -z "$ids" ]] && return 0

  local id action
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    action="$(jq -r --arg id "$id" '.items[] | select(.id==$id) | .action' <<<"$json")"
    log "Control request $id action=$action"
    case "$action" in
      reload_config)
        # Conf files are written by the web service; acknowledge reload for future polls.
        api POST "/api/v1/worker/internal/control/${id}/complete" '{"ok":true,"result":{"reloaded":true}}' >/dev/null
        ;;
      start)
        start_worker
        api POST "/api/v1/worker/internal/control/${id}/complete" '{"ok":true,"result":{"started":true}}' >/dev/null
        ;;
      stop)
        stop_worker_graceful
        api POST "/api/v1/worker/internal/control/${id}/complete" '{"ok":true,"result":{"stopped":true}}' >/dev/null
        ;;
      restart)
        stop_worker_graceful
        SHOULD_RUN=1
        STOP_REQUESTED=0
        start_worker
        api POST "/api/v1/worker/internal/control/${id}/complete" '{"ok":true,"result":{"restarted":true}}' >/dev/null
        ;;
      *)
        api POST "/api/v1/worker/internal/control/${id}/complete" '{"ok":false,"result":{"error":"unsupported_action"}}' >/dev/null
        ;;
    esac
  done <<<"$ids"
}

cleanup() {
  log "Wrapper shutting down"
  stop_worker_graceful
  exit 0
}

trap cleanup TERM INT

require_token
log "Platform worker wrapper starting"
heartbeat starting 0
start_worker

last_hb=0
last_ctrl=0
while true; do
  now="$(date +%s)"

  if [[ "$SHOULD_RUN" -eq 1 ]]; then
    if [[ -z "$WORKER_PID" ]] || ! kill -0 "$WORKER_PID" 2>/dev/null; then
      if [[ "$STOP_REQUESTED" -eq 0 ]]; then
        log "Worker process not running; restarting"
        start_worker
      fi
    fi
  fi

  if (( now - last_hb >= HEARTBEAT_INTERVAL )); then
    if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
      heartbeat running 0
    else
      heartbeat stopped 0
    fi
    last_hb=$now
  fi

  if (( now - last_ctrl >= CONTROL_POLL_INTERVAL )); then
    handle_control
    last_ctrl=$now
  fi

  sleep 1
done
