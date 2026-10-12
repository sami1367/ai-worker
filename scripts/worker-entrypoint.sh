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
    --exclude 'ssh/' \
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

# Make git HTTPS fetches/pushes use GH_TOKEN / GITLAB_TOKEN in non-interactive runs.
# Without this, `git fetch` fails with "could not read Username for 'https://...'".
if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]] && command -v gh >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi
if [[ -n "${GITLAB_TOKEN:-}" ]]; then
  # Host-scoped helper so GitHub credentials from `gh auth setup-git` stay intact.
  gitlab_host="${GITLAB_HOST:-gitlab.com}"
  gitlab_host="${gitlab_host#https://}"
  gitlab_host="${gitlab_host#http://}"
  gitlab_host="${gitlab_host%%/*}"
  git config --global "credential.https://${gitlab_host}.helper" \
    '!f() { echo "username=oauth2"; echo "password=${GITLAB_TOKEN}"; }; f' >/dev/null 2>&1 || true
fi

# Some GitLab instances disable HTTP git; use the platform SSH key when present.
if [[ -f "$DEST/ssh/id_ed25519" ]]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh" 2>/dev/null || true
  if [[ ! -f "$HOME/.ssh/id_ed25519" ]]; then
    cp "$DEST/ssh/id_ed25519" "$HOME/.ssh/id_ed25519"
    chmod 600 "$HOME/.ssh/id_ed25519"
  fi
  if [[ -f "$DEST/ssh/known_hosts" && ! -f "$HOME/.ssh/known_hosts" ]]; then
    cp "$DEST/ssh/known_hosts" "$HOME/.ssh/known_hosts"
    chmod 644 "$HOME/.ssh/known_hosts"
  fi
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
fi

# Commits from implement/review runs need an identity in this container.
git config --global user.name "${AI_WORKER_GIT_NAME:-AI Worker}"
git config --global user.email "${AI_WORKER_GIT_EMAIL:-ai-worker@users.noreply.github.com}"

exec bash "$DEST/platform-wrapper.sh"
