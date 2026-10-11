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
- Encrypted provider secrets (AES-256-GCM) with `SECRET_ENCRYPTION_KEY`
- Secrets scrubbed from audit metadata
- No arbitrary shell/Docker endpoints
- Worker control via allowlisted `control_requests`
- Remote URL validation (no embedded credentials, no `file:` / traversal)
- Managed workspace IDs; path escape checks
- Log streaming only for authorized run IDs with basename-safe paths
- PostgreSQL not published publicly by default
- Web bind defaults to loopback
- Non-root container user
- No Docker socket mount

## Production checklist

- [ ] Unique strong `POSTGRES_PASSWORD`, `NUXT_SESSION_PASSWORD` (≥32), `SECRET_ENCRYPTION_KEY`, `WORKER_INTERNAL_TOKEN`
- [ ] One-time `INITIAL_ADMIN_BOOTSTRAP_SECRET` rotated/removed after setup
- [ ] TLS reverse proxy; `APP_BASE_URL` is HTTPS
- [ ] Backups of PostgreSQL + `/data` volumes; encryption key stored offline
- [ ] Forge tokens scoped minimally
- [ ] Provider CLIs authenticated via secrets/volumes, not image layers
- [ ] Disk monitoring for workspaces/logs
- [ ] Restrict who can reach port 8080

## Key rotation

Rotating `SECRET_ENCRYPTION_KEY` invalidates encrypted provider secrets in PostgreSQL. Re-enter secrets via the UI after rotation. Session secret rotation invalidates all sessions.
