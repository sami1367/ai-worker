#!/usr/bin/env bash
# Load / persist / validate application secrets for container entrypoints.
# Never echo secret values.

APP_SECRETS_FILENAME="${APP_SECRETS_FILENAME:-app-secrets.env}"

app_secrets_path() {
  local base="${CONFIG_DIR:-${AI_WORKER_BASE_DIR:-/data/config}}"
  printf '%s/%s' "$base" "$APP_SECRETS_FILENAME"
}

# Fill empty env vars from persisted file. Non-empty env wins (rotation).
load_persisted_app_secrets() {
  local file
  file="$(app_secrets_path)"
  [[ -f "$file" ]] || return 0

  local key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key// /}"
    # Strip surrounding single quotes from our serializer
    if [[ "$value" == \'*\' ]]; then
      value="${value:1:-1}"
      value="${value//\'\\\'\'/\'}"
    fi
    case "$key" in
      DATABASE_URL|POSTGRES_PASSWORD|NUXT_SESSION_PASSWORD|SESSION_SECRET|SECRET_ENCRYPTION_KEY|WORKER_INTERNAL_TOKEN|INITIAL_ADMIN_BOOTSTRAP_SECRET)
        if [[ -z "${!key:-}" ]]; then
          export "$key=$value"
        fi
        ;;
    esac
  done < "$file"

  if [[ -z "${NUXT_SESSION_PASSWORD:-}" && -n "${SESSION_SECRET:-}" ]]; then
    export NUXT_SESSION_PASSWORD="$SESSION_SECRET"
  fi
}

_shell_quote() {
  local s=$1
  s=${s//\'/\'\\\'\'}
  printf "'%s'" "$s"
}

# Write current env secrets to the data volume (0600).
persist_app_secrets_from_env() {
  local file tmp dir
  file="$(app_secrets_path)"
  dir="$(dirname "$file")"
  mkdir -p "$dir"

  if [[ -z "${DATABASE_URL:-}" || -z "${SECRET_ENCRYPTION_KEY:-}" || -z "${WORKER_INTERNAL_TOKEN:-}" ]]; then
    return 1
  fi
  if [[ -z "${NUXT_SESSION_PASSWORD:-}" && -z "${SESSION_SECRET:-}" ]]; then
    return 1
  fi

  tmp="${file}.$$.tmp"
  {
    echo '# Persisted application secrets — mode 0600. Do not commit.'
    echo '# Host .env may be removed after first successful start; this file remains on the data volume.'
    echo
    echo "DATABASE_URL=$(_shell_quote "$DATABASE_URL")"
    [[ -n "${POSTGRES_PASSWORD:-}" ]] && echo "POSTGRES_PASSWORD=$(_shell_quote "$POSTGRES_PASSWORD")"
    if [[ -n "${NUXT_SESSION_PASSWORD:-}" ]]; then
      echo "NUXT_SESSION_PASSWORD=$(_shell_quote "$NUXT_SESSION_PASSWORD")"
    elif [[ -n "${SESSION_SECRET:-}" ]]; then
      echo "NUXT_SESSION_PASSWORD=$(_shell_quote "$SESSION_SECRET")"
    fi
    [[ -n "${SESSION_SECRET:-}" ]] && echo "SESSION_SECRET=$(_shell_quote "$SESSION_SECRET")"
    echo "SECRET_ENCRYPTION_KEY=$(_shell_quote "$SECRET_ENCRYPTION_KEY")"
    echo "WORKER_INTERNAL_TOKEN=$(_shell_quote "$WORKER_INTERNAL_TOKEN")"
    [[ -n "${INITIAL_ADMIN_BOOTSTRAP_SECRET:-}" ]] && echo "INITIAL_ADMIN_BOOTSTRAP_SECRET=$(_shell_quote "$INITIAL_ADMIN_BOOTSTRAP_SECRET")"
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
  return 0
}

_is_known_insecure() {
  local v="$1"
  local lower
  lower="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    changeme|password|secret|admin) return 0 ;;
    n8kx2mq7pl4vr9wt1yh6jc3bf5da0se2uz) return 0 ;;
    a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00) return 0 ;;
    wk_7f3a9c2e1b8d4f6a0e5c9b2d7a1f4e8c3b6d9e0a2f5c8) return 0 ;;
    aw7kp9mx2qr5vn8jl3hc6ty1we4us0bz) return 0 ;;
  esac
  if [[ "$v" =~ ^(changeme|password|secret|admin|test|default)[0-9_-]*$ ]]; then
    return 0
  fi
  return 1
}

_check_secret() {
  local name="$1" value="$2" min="$3"
  if [[ -z "$value" ]]; then
    echo "missing:$name"
    return
  fi
  if (( ${#value} < min )) || _is_known_insecure "$value"; then
    echo "insecure:$name"
  fi
}

# Prints issue lines (missing:NAME / insecure:NAME). Exit 0 if ok, 1 if not.
validate_app_secrets() {
  local issues=()
  local session="${NUXT_SESSION_PASSWORD:-${SESSION_SECRET:-}}"
  local line

  while IFS= read -r line; do
    [[ -n "$line" ]] && issues+=("$line")
  done < <(
    _check_secret DATABASE_URL "${DATABASE_URL:-}" 1
    _check_secret NUXT_SESSION_PASSWORD "$session" 32
    _check_secret SECRET_ENCRYPTION_KEY "${SECRET_ENCRYPTION_KEY:-}" 32
    _check_secret WORKER_INTERNAL_TOKEN "${WORKER_INTERNAL_TOKEN:-}" 32
  )

  if [[ -n "${INITIAL_ADMIN_BOOTSTRAP_SECRET:-}" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && issues+=("$line")
    done < <(_check_secret INITIAL_ADMIN_BOOTSTRAP_SECRET "$INITIAL_ADMIN_BOOTSTRAP_SECRET" 16)
  fi

  if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && issues+=("$line")
    done < <(_check_secret POSTGRES_PASSWORD "$POSTGRES_PASSWORD" 16)
  fi

  if ((${#issues[@]} > 0)); then
    local missing=() insecure=()
    local item
    for item in "${issues[@]}"; do
      case "$item" in
        missing:*) missing+=("${item#missing:}") ;;
        insecure:*) insecure+=("${item#insecure:}") ;;
      esac
    done
    echo "ERROR: Invalid or incomplete application secrets." >&2
    if ((${#missing[@]} > 0)); then
      echo "  Missing: ${missing[*]}" >&2
    fi
    if ((${#insecure[@]} > 0)); then
      echo "  Insecure or too weak: ${insecure[*]}" >&2
      echo "  Do not use published defaults or values like changeme." >&2
    fi
    echo "  Run scripts/generate-env.sh to create a secure .env, then: docker compose up -d" >&2
    echo "  After the first successful start, secrets are stored in $(app_secrets_path) on the data volume." >&2
    return 1
  fi
  return 0
}

# Load → persist → validate. Safe for web, migrate, and worker entrypoints.
ensure_app_secrets() {
  mkdir -p "${CONFIG_DIR:-${AI_WORKER_BASE_DIR:-/data/config}}"
  load_persisted_app_secrets
  if [[ -z "${NUXT_SESSION_PASSWORD:-}" && -n "${SESSION_SECRET:-}" ]]; then
    export NUXT_SESSION_PASSWORD="$SESSION_SECRET"
  fi
  # Best-effort persist when we have a full set (enables removing host .env later).
  persist_app_secrets_from_env || true
  validate_app_secrets
}
