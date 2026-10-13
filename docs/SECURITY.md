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

## Known limitations

- Worker forge auth is process-global (`GH_TOKEN` / `GITLAB_TOKEN`). Multiple simultaneous GitHub identities are not supported; the most recently validated active connection is exported.
- OAuth user tokens may lack org SSO authorization or fine-grained permissions required for some org repos — reconnect or grant access in the provider UI.
- Successful OAuth does not guarantee every worker write action (labels, releases) if an admin later reduces scopes.
- Disconnect revokes tokens when the provider API supports it; always treat disconnect as best-effort revoke + local credential wipe.
