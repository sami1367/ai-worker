#!/usr/bin/env bash
# Generate or complete a cryptographically secure .env for AI Worker.
#
# Usage:
#   ./scripts/generate-env.sh                 # create/complete ./.env
#   ./scripts/generate-env.sh --force         # rotate all required secrets
#   curl -fsSL .../generate-env.sh | bash     # same, after .env.example was downloaded
#   ./scripts/generate-env.sh /path/.env
#
# Safe with a copied .env.example: placeholder/comment-only files are completed
# automatically (no --force needed). Existing strong secrets are left alone.
set -Eeuo pipefail

FORCE=0
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "ERROR: unexpected argument: $arg" >&2
        exit 2
      fi
      TARGET="$arg"
      ;;
  esac
done

TARGET="${TARGET:-.env}"
# Easy-to-find copy of the one-time setup secret (same directory as .env)
BOOTSTRAP_FILE="$(dirname -- "$TARGET")/INITIAL_ADMIN_BOOTSTRAP_SECRET.txt"
if [[ "$BOOTSTRAP_FILE" == "./INITIAL_ADMIN_BOOTSTRAP_SECRET.txt" || "$BOOTSTRAP_FILE" == "INITIAL_ADMIN_BOOTSTRAP_SECRET.txt" ]]; then
  BOOTSTRAP_FILE="INITIAL_ADMIN_BOOTSTRAP_SECRET.txt"
elif [[ "$(dirname -- "$TARGET")" == "." ]]; then
  BOOTSTRAP_FILE="INITIAL_ADMIN_BOOTSTRAP_SECRET.txt"
else
  BOOTSTRAP_FILE="$(cd "$(dirname -- "$TARGET")" && pwd)/INITIAL_ADMIN_BOOTSTRAP_SECRET.txt"
fi

write_bootstrap_file() {
  local secret="$1"
  umask 077
  printf '%s\n' "$secret" >"$BOOTSTRAP_FILE"
  chmod 600 "$BOOTSTRAP_FILE"
}

print_bootstrap() {
  local secret="$1"
  echo ""
  echo "============================================================"
  echo "  INITIAL_ADMIN_BOOTSTRAP_SECRET (use once at /setup)"
  echo "============================================================"
  echo "  $secret"
  echo "============================================================"
  echo "  Also saved to: $BOOTSTRAP_FILE"
  echo "  Show again:    cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt"
  echo "                 grep INITIAL_ADMIN_BOOTSTRAP_SECRET .env"
  echo "============================================================"
  echo ""
}

rand_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    dd if=/dev/urandom bs="$bytes" count=1 status=none | od -An -tx1 | tr -d ' \n'
  fi
}

# Read KEY=value from an env file into ENV_<KEY> (uncommented assignments only).
load_existing() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    case "$key" in
      POSTGRES_PASSWORD|DATABASE_URL|NUXT_SESSION_PASSWORD|SESSION_SECRET|SECRET_ENCRYPTION_KEY|WORKER_INTERNAL_TOKEN|INITIAL_ADMIN_BOOTSTRAP_SECRET|APP_BASE_URL|GITHUB_TOKEN|GITLAB_HOST|GITLAB_TOKEN|CURSOR_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|WORKERS|CHECK_INTERVAL|AI_WORKER_IMAGE|WEB_BIND)
        printf -v "ENV_${key}" '%s' "$value"
        ;;
    esac
  done <"$file"
}

is_placeholder() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  case "$value" in
    *'<'*|*'generate-env'*|changeme|password|secret|admin) return 0 ;;
  esac
  # Former published Compose defaults
  case "$value" in
    n8Kx2mQ7pL4vR9wT1yH6jC3bF5dA0sE2uZ|a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00|wk_7f3a9c2e1b8d4f6a0e5c9b2d7a1f4e8c3b6d9e0a2f5c8|Aw7kP9mX2qR5vN8jL3hC6tY1wE4uS0bZ)
      return 0
      ;;
  esac
  return 1
}

need_secret() {
  local value="${1:-}" min="${2:-16}"
  if [[ "$FORCE" -eq 1 ]]; then return 0; fi
  is_placeholder "$value" && return 0
  (( ${#value} < min )) && return 0
  return 1
}

load_existing "$TARGET"

# Completing a downloaded .env.example is the normal path — never require --force for that.
if [[ -f "$TARGET" && "$FORCE" -ne 1 ]]; then
  if ! need_secret "${ENV_POSTGRES_PASSWORD:-}" 16 \
    && ! need_secret "${ENV_NUXT_SESSION_PASSWORD:-${ENV_SESSION_SECRET:-}}" 32 \
    && ! need_secret "${ENV_SECRET_ENCRYPTION_KEY:-}" 32 \
    && ! need_secret "${ENV_WORKER_INTERNAL_TOKEN:-}" 32 \
    && ! need_secret "${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET:-}" 16; then
    write_bootstrap_file "${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET}"
    echo "Secure secrets already present in $TARGET — leaving them unchanged."
    print_bootstrap "${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET}"
    echo "Next: docker compose up -d"
    exit 0
  fi
fi

if need_secret "${ENV_POSTGRES_PASSWORD:-}" 16; then
  ENV_POSTGRES_PASSWORD="$(rand_hex 32)"
fi
ENV_DATABASE_URL="postgresql://aiworker:${ENV_POSTGRES_PASSWORD}@db:5432/aiworker"

if need_secret "${ENV_NUXT_SESSION_PASSWORD:-${ENV_SESSION_SECRET:-}}" 32; then
  ENV_NUXT_SESSION_PASSWORD="$(rand_hex 32)"
fi
ENV_NUXT_SESSION_PASSWORD="${ENV_NUXT_SESSION_PASSWORD:-${ENV_SESSION_SECRET}}"

if need_secret "${ENV_SECRET_ENCRYPTION_KEY:-}" 32; then
  ENV_SECRET_ENCRYPTION_KEY="$(rand_hex 32)"
fi

if need_secret "${ENV_WORKER_INTERNAL_TOKEN:-}" 32; then
  ENV_WORKER_INTERNAL_TOKEN="wk_$(rand_hex 24)"
fi

if need_secret "${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET:-}" 16; then
  ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET="$(rand_hex 24)"
fi

ENV_APP_BASE_URL="${ENV_APP_BASE_URL:-http://127.0.0.1:8080}"

opt_line() {
  local key="$1" value="${2:-}"
  if [[ -n "$value" ]]; then
    printf '%s=%s\n' "$key" "$value"
  else
    printf '# %s=\n' "$key"
  fi
}

umask 077
cat >"$TARGET" <<EOF
# Generated by scripts/generate-env.sh — do not commit.
# After the first successful \`docker compose up\`, secrets are also persisted
# on the data volume as /data/config/app-secrets.env. You may then remove this
# file if you no longer need host-side env overrides (optional tokens below).

POSTGRES_PASSWORD=${ENV_POSTGRES_PASSWORD}
DATABASE_URL=${ENV_DATABASE_URL}
NUXT_SESSION_PASSWORD=${ENV_NUXT_SESSION_PASSWORD}
SECRET_ENCRYPTION_KEY=${ENV_SECRET_ENCRYPTION_KEY}
WORKER_INTERNAL_TOKEN=${ENV_WORKER_INTERNAL_TOKEN}
INITIAL_ADMIN_BOOTSTRAP_SECRET=${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET}

# Public URL (change behind TLS reverse proxy)
APP_BASE_URL=${ENV_APP_BASE_URL}

# Optional forge / AI provider tokens (or configure in the UI)
$(opt_line GITHUB_TOKEN "${ENV_GITHUB_TOKEN:-}")
$(opt_line GITLAB_HOST "${ENV_GITLAB_HOST:-}")
$(opt_line GITLAB_TOKEN "${ENV_GITLAB_TOKEN:-}")
$(opt_line CURSOR_API_KEY "${ENV_CURSOR_API_KEY:-}")
$(opt_line ANTHROPIC_API_KEY "${ENV_ANTHROPIC_API_KEY:-}")
$(opt_line CLAUDE_CODE_OAUTH_TOKEN "${ENV_CLAUDE_CODE_OAUTH_TOKEN:-}")

$(opt_line WORKERS "${ENV_WORKERS:-}")
$(opt_line CHECK_INTERVAL "${ENV_CHECK_INTERVAL:-}")
$(opt_line AI_WORKER_IMAGE "${ENV_AI_WORKER_IMAGE:-}")
$(opt_line WEB_BIND "${ENV_WEB_BIND:-}")
EOF
chmod 600 "$TARGET"
write_bootstrap_file "${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET}"

echo "Wrote secure environment file: $TARGET (mode 0600)."
print_bootstrap "${ENV_INITIAL_ADMIN_BOOTSTRAP_SECRET}"
echo "Next: docker compose up -d"
