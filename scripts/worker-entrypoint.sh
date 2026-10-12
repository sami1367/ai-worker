#!/usr/bin/env bash
set -Eeuo pipefail

# Sync immutable worker scripts into the persistent config volume on start.
# Conf files and runtime state live on the volume; code comes from the image.

SRC="/app/worker"
DEST="${AI_WORKER_BASE_DIR:-/data/config}"

mkdir -p "$DEST" "$DEST/logs" "$DEST/state" "${WORKSPACE_ROOT:-/data/workspaces}"

# Copy scripts/libs/prompts if missing or image is newer (rsync-like)
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'logs/' \
    --exclude 'state/' \
    --exclude 'github-projects.conf' \
    --exclude 'gitlab-projects.conf' \
    --exclude 'forge-credentials.env' \
    --exclude 'provider-credentials.env' \
    --exclude '.env' \
    "$SRC/" "$DEST/"
else
  # Fallback copy without deleting operator conf
  cp -a "$SRC"/*.sh "$DEST"/ 2>/dev/null || true
  cp -a "$SRC"/lib "$DEST"/
  cp -a "$SRC"/prompts "$DEST"/
  cp -a "$SRC"/platform-wrapper.sh "$DEST"/
  chmod +x "$DEST"/*.sh
fi

# Ensure empty conf arrays exist so worker can start before UI export
if [[ ! -f "$DEST/github-projects.conf" ]]; then
  echo '[]' > "$DEST/github-projects.conf"
fi
if [[ ! -f "$DEST/gitlab-projects.conf" ]]; then
  echo '[]' > "$DEST/gitlab-projects.conf"
fi

export AI_WORKER_BASE_DIR="$DEST"
export LOGS_DIR="${LOGS_DIR:-$DEST/logs}"
export STATE_DIR="${STATE_DIR:-$DEST/state}"

# Load forge credentials materialized by the web control plane (0600 env file).
# Never logs file contents. Compose env vars remain a fallback when the file is absent.
if [[ -f "$DEST/forge-credentials.env" ]]; then
  # shellcheck disable=SC1091
  source "$DEST/forge-credentials.env"
fi

# Load AI provider credentials (CURSOR_API_KEY / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN).
if [[ -f "$DEST/provider-credentials.env" ]]; then
  # shellcheck disable=SC1091
  source "$DEST/provider-credentials.env"
fi

exec bash "$DEST/platform-wrapper.sh"
