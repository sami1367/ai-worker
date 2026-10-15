# Security

## Threat model

This platform can trigger AI agents that modify repository working trees and open PRs/MRs. Compromise of an admin session is equivalent to automated code-change capability on registered repositories.

## Controls implemented

- Argon2id password hashing
- PostgreSQL-backed sessions (HttpOnly, SameSite=Lax, Secure in production)
- Session rotation on login; session invalidation on password change
- Login rate limiting (per username and IP hash)
- Generic authentication failure messages
- Role checks (`admin` / `operator`) on mutating APIs
- CSRF mitigation via SameSite cookies for browser clients
- Encrypted AI provider secrets and forge OAuth tokens (AES-256-GCM) with `SECRET_ENCRYPTION_KEY`
- **No default/hardcoded secrets in Compose or `.env.example`** — `scripts/generate-env.sh` creates CSPRNG values
- Startup and container entrypoint **fail closed** if required secrets are missing or match known insecure defaults (including former published Compose values and `changeme`)
- First-run bootstrap rejects insecure `INITIAL_ADMIN_BOOTSTRAP_SECRET`
- Required secrets persisted to `/data/config/app-secrets.env` (mode `0600`) so the host `.env` can be removed after setup
- Secrets scrubbed from audit metadata, logs, and API payloads (`redactSecrets`); diagnostics report only booleans for secret presence
- OAuth authorization-code + PKCE; one-time `state`; callback open-redirect blocked
- GitLab instance URL SSRF protections + optional `GITLAB_TRUSTED_HOSTS` allowlist
- No arbitrary shell/Docker endpoints
- Worker control via allowlisted `control_requests`
- Forge webhooks verified with per-connection secrets (GitHub HMAC-SHA256 / GitLab `X-Gitlab-Token`); endpoints are unauthenticated except for that secret
- Remote URL validation (no embedded credentials, no `file:` / traversal)
- Managed workspace IDs; path escape checks; async clone/sync queue
- Log streaming only for authorized run IDs with basename-safe paths
- PostgreSQL not published publicly by default
- Web bind defaults to loopback
- Non-root container user
- No Docker socket mount
- Forge and AI provider credentials files on shared volume are mode `0600` and excluded from worker rsync deletes

## Secure initialization

1. Follow the README Quick start (downloads Compose + `.env.example`, runs `generate-env.sh`, starts Compose).
2. `generate-env.sh` completes `.env` (mode `0600`) with CSPRNG values for:
   - `POSTGRES_PASSWORD` / `DATABASE_URL`
   - `NUXT_SESSION_PASSWORD`
   - `SECRET_ENCRYPTION_KEY` (64 hex chars)
   - `WORKER_INTERNAL_TOKEN`
   - `INITIAL_ADMIN_BOOTSTRAP_SECRET`
3. Open `/setup` with the printed bootstrap secret; choose a strong admin password (min 12).
4. Optional: remove host `.env` after confirming health — persisted secrets remain on the `data` volume.

A copied `.env.example` alone is not enough to start; `generate-env.sh` (included in the Quick start) fills secrets automatically.

Escape hatch for local experiments only: `AI_WORKER_ALLOW_INSECURE_SECRETS=1` (never in production).

## Migrating from older Compose defaults

Older versions shipped predictable secrets in `docker-compose.yml` (including bootstrap default `changeme`). Treat those values as **compromised**.

### Fresh volume (acceptable data loss)

```bash
docker compose down -v
./scripts/generate-env.sh --force   # or ./generate-env.sh --force
docker compose up -d
# Complete /setup again with the new bootstrap secret
```

### Keep existing Postgres data

1. Pull the new `docker-compose.yml` (no embedded secrets).
2. Create a new `.env` with `./scripts/generate-env.sh`.
3. **Keep the current Postgres password** in `.env` temporarily if the volume was initialized with it — or change it inside Postgres first:

   ```bash
   # While the old stack is still running with the old password:
   docker compose exec -T db psql -U aiworker -c "ALTER USER aiworker PASSWORD 'NEW_SECURE_PASSWORD';"
   ```

4. Put the same new password in `POSTGRES_PASSWORD` and `DATABASE_URL` in `.env`.
5. Generate new `NUXT_SESSION_PASSWORD`, `SECRET_ENCRYPTION_KEY`, and `WORKER_INTERNAL_TOKEN` (generate-env does this).
6. `docker compose up -d`
7. Re-enter AI provider secrets and reconnect forge OAuth (encryption key rotation invalidates ciphertext).
8. Complete admin login (sessions invalidated by session secret rotation). If you still need `/setup`, set a new `INITIAL_ADMIN_BOOTSTRAP_SECRET` only when no admin user exists.

Former published default passwords are rejected at startup; you cannot keep using them.

## Production checklist

- [ ] Ran `generate-env.sh` (or equivalent CSPRNG); no `changeme` / published defaults
- [ ] Postgres is internal-only; host `.env` mode `0600` (or removed after persist)
- [ ] Offline backup of `SECRET_ENCRYPTION_KEY` + session secret + Postgres password
- [ ] TLS reverse proxy; `APP_BASE_URL` is HTTPS and matches OAuth callback URLs (and is reachable by GitHub/GitLab for webhooks)
- [ ] GitHub/GitLab OAuth apps configured with exact callback URLs
- [ ] Backups of PostgreSQL + `/data` volumes
- [ ] Forge OAuth scopes reviewed (`repo` / GitLab `api` are powerful — treat as production secrets)
- [ ] `GITLAB_TRUSTED_HOSTS` limited to known self-managed instances
- [ ] Provider CLIs authenticated via Providers UI secrets or Compose env, not image layers
- [ ] Disk monitoring for workspaces/logs
- [ ] Restrict who can reach port 8080

## Key rotation

Rotating `SECRET_ENCRYPTION_KEY` invalidates encrypted AI provider secrets **and** forge OAuth tokens in PostgreSQL. Reconnect forge accounts and re-enter AI secrets after rotation. Session secret rotation invalidates all sessions.

Update values in `.env` (or recreate with care), restart; the entrypoint rewrites `/data/config/app-secrets.env` when non-empty env values are provided.

## AI agent ↔ forge isolation

AI agents (Cursor CLI / Claude Code) run in a **separate execution phase** from GitHub/GitLab publishing.

| Phase | Who | Capabilities |
|-------|-----|--------------|
| **AGENT** | Cursor / Claude under `ai_isolation_exec` | Read/modify the assigned workspace; run permitted tools; write task artifacts. **No** forge write tokens, **no** git credential helpers, **no** platform SSH keys, **no** `forge-credentials.env` / `app-secrets.env` / `.env`. |
| **VALIDATE** | Trusted runner scripts | Inspect diffs, secret-file gates, no-change/review allowlists, forge-text validation. Does **not** execute agent-provided shell. |
| **PUBLISH** | Trusted runner scripts | Commit, push, force-push (when configured), open PR/MR, post comments, update labels — using forge credentials held only by the orchestration process. |

### Technical controls

- **Environment scrub** — agent child processes unset `GH_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN`, `GIT_SSH_COMMAND`, `WORKER_INTERNAL_TOKEN`, DB/session/encryption secrets, etc. AI provider keys (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) remain so the CLIs can call their APIs.
- **Git auth disabled for the agent** — `GIT_CONFIG_*` overrides clear credential helpers; `GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=/bin/false`.
- **Bubblewrap filesystem overlays** (default when `bwrap` is installed) — mask credential files with empty binds; tmpfs over SSH / `gh` config dirs; workspaces root read-only except the assigned workspace (writable).
- **Provider defense in depth** — Cursor `--sandbox enabled` by default; Claude review/answer tasks default to a Bash-free `--allowedTools` list. These are **not** the security boundary.
- **Logs** — agent / validate / publish phases are logged separately; token values are never printed.

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `AI_ISOLATION_MODE` | `auto` | `auto` (bwrap if present else env), `bwrap` (require bubblewrap), `env` (scrub only), `off` (insecure escape hatch) |
| `AI_CURSOR_SANDBOX` | `enabled` | Passed to Cursor CLI `--sandbox` |
| `AI_CLAUDE_ALLOWED_TOOLS` | (unset) | Optional override; review tasks default to `Read,Glob,Grep,Write,Edit` |
| `AI_CLAUDE_REVIEW_ALLOWED_TOOLS` | see above | Override review/answer tool allowlist |

Images install `bubblewrap`. Host/systemd installs without `bwrap` fall back to **env scrub only** — still strips tokens from the agent process, but cannot hide credential files on disk. Install `bubblewrap` (or run the Docker image) for full filesystem isolation.

Automated checks: `bash worker/tests/agent-isolation.sh` (included in `pnpm test:worker`).

## Known limitations

- Worker forge auth is process-global for the **orchestration** process (`GH_TOKEN` / `GITLAB_TOKEN`). Multiple simultaneous GitHub identities are not supported; the most recently validated active connection is exported. These tokens are **not** exported into the AI agent phase.
- Agent network namespace is shared (AI provider APIs must be reachable). Without forge tokens / SSH keys / credential helpers, authenticated forge writes still fail; unauthenticated public HTTP is not blocked.
- Bubblewrap is unavailable on some host kernels or restricted container runtimes → `AI_ISOLATION_MODE=env` behavior; credential **files** may remain readable though tokens are scrubbed from the environment. Prefer the Compose image (includes `bubblewrap`).
- Provider tool allowlists / Cursor sandbox can be widened by operator env (`AI_CLAUDE_*`, `AI_CURSOR_*`); OS isolation remains the boundary.
- OAuth user tokens may lack org SSO authorization or fine-grained permissions required for some org repos — reconnect or grant access in the provider UI.
- Successful OAuth does not guarantee every worker write action (labels, releases) if an admin later reduces scopes.
- Disconnect revokes tokens when the provider API supports it; always treat disconnect as best-effort revoke + local credential wipe.
