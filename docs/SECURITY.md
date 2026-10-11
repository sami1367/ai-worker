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
- Secrets scrubbed from audit metadata, logs, and API payloads (`redactSecrets`)
- OAuth authorization-code + PKCE; one-time `state`; callback open-redirect blocked
- GitLab instance URL SSRF protections + optional `GITLAB_TRUSTED_HOSTS` allowlist
- No arbitrary shell/Docker endpoints
- Worker control via allowlisted `control_requests`
- Remote URL validation (no embedded credentials, no `file:` / traversal)
- Managed workspace IDs; path escape checks; async clone/sync queue
- Log streaming only for authorized run IDs with basename-safe paths
- PostgreSQL not published publicly by default
- Web bind defaults to loopback
- Non-root container user
- No Docker socket mount
- Forge credentials file on shared volume is mode `0600` and excluded from worker rsync deletes

## Production checklist

- [ ] Unique strong `POSTGRES_PASSWORD`, `NUXT_SESSION_PASSWORD` (≥32), `SECRET_ENCRYPTION_KEY`, `WORKER_INTERNAL_TOKEN`
- [ ] One-time `INITIAL_ADMIN_BOOTSTRAP_SECRET` rotated/removed after setup
- [ ] TLS reverse proxy; `APP_BASE_URL` is HTTPS and matches OAuth callback URLs
- [ ] GitHub/GitLab OAuth apps configured with exact callback URLs
- [ ] Backups of PostgreSQL + `/data` volumes; encryption key stored offline
- [ ] Forge OAuth scopes reviewed (`repo` / GitLab `api` are powerful — treat as production secrets)
- [ ] `GITLAB_TRUSTED_HOSTS` limited to known self-managed instances
- [ ] Provider CLIs authenticated via secrets/volumes, not image layers
- [ ] Disk monitoring for workspaces/logs
- [ ] Restrict who can reach port 8080

## Key rotation

Rotating `SECRET_ENCRYPTION_KEY` invalidates encrypted AI provider secrets **and** forge OAuth tokens in PostgreSQL. Reconnect forge accounts and re-enter AI secrets after rotation. Session secret rotation invalidates all sessions.

## Known limitations

- Worker forge auth is process-global (`GH_TOKEN` / `GITLAB_TOKEN`). Multiple simultaneous GitHub identities are not supported; the most recently validated active connection is exported.
- OAuth user tokens may lack org SSO authorization or fine-grained permissions required for some org repos — reconnect or grant access in the provider UI.
- Successful OAuth does not guarantee every worker write action (labels, releases) if an admin later reduces scopes.
- Disconnect revokes tokens when the provider API supports it; always treat disconnect as best-effort revoke + local credential wipe.
