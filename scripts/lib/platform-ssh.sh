# Ensure a single platform ed25519 keypair on the shared data volume.
# Private key stays on the volume (0600); never printed. Public key is for forge UI.
# Safe to call from web and worker entrypoints (idempotent; race-tolerant).

ensure_platform_ssh_key() {
  local base="${CONFIG_DIR:-${AI_WORKER_BASE_DIR:-/data/config}}"
  local dir="${base}/ssh"
  local key="${dir}/id_ed25519"
  local pub="${key}.pub"
  local tmp_key tmp_pub
  local comment="${AI_WORKER_SSH_KEY_COMMENT:-ai-worker-platform}"

  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true

  if [[ -f "$key" && -f "$pub" ]]; then
    chmod 600 "$key" 2>/dev/null || true
    chmod 644 "$pub" 2>/dev/null || true
    return 0
  fi

  if ! command -v ssh-keygen >/dev/null 2>&1; then
    echo "[platform-ssh] WARNING: ssh-keygen not found; cannot generate platform key" >&2
    return 1
  fi

  tmp_key="$(mktemp "${dir}/.id_ed25519.XXXXXX")"
  tmp_pub="${tmp_key}.pub"
  # Empty passphrase — key is protected by volume permissions (0600 + 700 dir).
  if ! ssh-keygen -q -t ed25519 -N '' -C "$comment" -f "$tmp_key"; then
    rm -f "$tmp_key" "$tmp_pub"
    echo "[platform-ssh] WARNING: ssh-keygen failed" >&2
    return 1
  fi

  chmod 600 "$tmp_key"
  chmod 644 "$tmp_pub"

  # Atomic publish: only one writer wins if web/worker race.
  if [[ ! -f "$key" ]]; then
    mv -f "$tmp_key" "$key"
  else
    rm -f "$tmp_key"
  fi
  if [[ ! -f "$pub" ]]; then
    mv -f "$tmp_pub" "$pub"
  else
    rm -f "$tmp_pub"
  fi

  chmod 600 "$key" 2>/dev/null || true
  chmod 644 "$pub" 2>/dev/null || true
  echo "[platform-ssh] Generated platform SSH key (public key available in Connections UI)"
  return 0
}
