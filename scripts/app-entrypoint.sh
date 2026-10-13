#!/usr/bin/env bash
# Container entrypoint: load/persist/validate secrets, then exec the service command.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/app-secrets.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/platform-ssh.sh"

export CONFIG_DIR="${CONFIG_DIR:-/data/config}"
export AI_WORKER_BASE_DIR="${AI_WORKER_BASE_DIR:-$CONFIG_DIR}"

if [[ "${AI_WORKER_ALLOW_INSECURE_SECRETS:-}" == "1" ]]; then
  load_persisted_app_secrets || true
  persist_app_secrets_from_env || true
else
  ensure_app_secrets
fi

# One shared keypair for web + all workers (private key never leaves the volume).
ensure_platform_ssh_key || true

exec "$@"
