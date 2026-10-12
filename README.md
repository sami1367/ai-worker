# AI Worker Platform

Self-hosted web platform for managing the AI Worker automation engine (GitHub + GitLab issue implementation, PR/MR reviews, Cursor CLI / Claude Code).

The Bash worker remains the execution engine. The Nuxt management app provides authentication, PostgreSQL-backed configuration, task history, live logs, and worker control — without editing JSON conf files for day-to-day operations.

## Features

- Secure admin dashboard (Nuxt 3 + Nuxt UI)
- PostgreSQL persistence (Drizzle migrations)
- GitHub / GitLab OAuth connections with encrypted token storage
- Automatic repository discovery, selection, and persistent workspace clones
- Repository management with per-repo `block_on_open_pr`
- Cursor + Claude CLIs installed in the Docker image; connect/manage keys in Providers UI
- Task history + SSE log streaming
- Worker heartbeat and control requests (reload/start/stop/restart)
- Atomic config export to worker JSON registries
- Docker Compose deployment (`web`, `worker`, `db`)
- Import tool for existing `github-projects.conf` / `gitlab-projects.conf`

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Logical services: **web**, **worker**, **PostgreSQL**. The web process never runs AI agents.

## Prerequisites

- Node.js 20+ and pnpm 9+ (development)
- Docker + Docker Compose (deployment)
- GitHub CLI auth and/or GitLab token for forge automation
- Docker build installs Cursor Agent CLI + Claude Code CLI (or install locally via `scripts/install-ai-clis.sh`)

## Quick start (Docker)

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, NUXT_SESSION_PASSWORD (>=32 chars),
# SECRET_ENCRYPTION_KEY (64 hex chars), INITIAL_ADMIN_BOOTSTRAP_SECRET,
# WORKER_INTERNAL_TOKEN

docker compose build
docker compose up -d

curl -fsS http://127.0.0.1:8080/api/v1/health
```

Open `http://127.0.0.1:8080/setup` and create the first administrator using `INITIAL_ADMIN_BOOTSTRAP_SECRET`. No default password is shipped.

## Development

```bash
pnpm install
# Start Postgres (compose db only) or provide DATABASE_URL
pnpm db:migrate
pnpm dev
pnpm test:unit
pnpm test:worker
pnpm build
```

## First-run administrator setup

1. Ensure `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_BOOTSTRAP_SECRET` are set.
2. Visit `/setup` while the database has zero users.
3. Choose a strong password (≥12 characters).
4. Rotate/remove the bootstrap secret after success.

## Environment configuration

See [`.env.example`](.env.example) for every variable. Required in production:

- `DATABASE_URL`
- `NUXT_SESSION_PASSWORD` / `SESSION_SECRET`
- `SECRET_ENCRYPTION_KEY`
- `WORKER_INTERNAL_TOKEN`
- Bootstrap secrets for first admin only

## Docker deployment

Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Services: `db`, `migrate`, `web`, `worker`. Volumes: Postgres data, config export, workspaces, logs, state. Only the web port is published (`127.0.0.1:8080` by default).

## Reverse proxy and HTTPS

Terminate TLS in front of `127.0.0.1:8080`. Set `APP_BASE_URL` to the public HTTPS URL.

## GitHub / GitLab connections (recommended)

1. Open **Connections** in the UI.
2. **GitHub:** paste a personal access token with the full classic `repo` scope (`public_repo` alone only lists public repos). Fine-grained: grant private repository access (org private repos need the org as resource owner) plus Metadata/Contents/Issues/PRs. Optional browser OAuth if `GITHUB_OAUTH_CLIENT_*` is set.
3. **GitLab:** enter server URL + personal access token (`api` scope; `read_api` minimum to list private projects).
4. Connecting is enough: every visible repo is **auto-registered and enabled**. Local clones happen **lazily** when an `ai` / `ai-review` job needs the workspace. New repos are picked up every **15 minutes**, or immediately via **Fetch new repos** on the Repositories page.

Tokens are encrypted at rest (`SECRET_ENCRYPTION_KEY`) and never returned to the browser after connect. The web service materializes forge credentials into `/data/config/forge-credentials.env` (mode `0600`) for the worker entrypoint. Compose env `GH_TOKEN` / `GITLAB_TOKEN` remain a fallback.

### Optional GitHub OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New.
2. Authorization callback URL: `${APP_BASE_URL}/api/v1/connections/oauth/github/callback`
3. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
4. Requested scopes: `repo`, `read:user`, `user:email`.

### GitLab self-managed notes

For private/self-managed hosts, add hostnames to `GITLAB_TRUSTED_HOSTS`. HTTP is denied unless `GITLAB_ALLOW_HTTP=true` **and** the host is allowlisted.

### AI providers

Docker images install both CLIs at build time (`scripts/install-ai-clis.sh`):

- **Cursor:** `agent` / `cursor-agent` on PATH
- **Claude:** `claude` on PATH

Connect credentials in **Providers** (admin):

| Provider | Secret | Worker env |
|----------|--------|------------|
| Cursor | Cursor API key | `CURSOR_API_KEY` |
| Claude | Anthropic API key or Claude OAuth token | `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` |

Secrets are encrypted with `SECRET_ENCRYPTION_KEY`, never returned to the browser, and materialized to `/data/config/provider-credentials.env` (mode `0600`) for the worker. Disconnect clears the stored secret. Compose env vars remain a fallback. Health checks detect binaries and whether credential material is configured — they do not call the provider APIs.

## Repository registration

**Preferred:** Connections → discover → select → clone into `/data/workspaces/<workspaceId>`.

**Manual:** Repositories → Manual add (remote URL + optional host path for legacy imports). Removing a registration does not delete the workspace unless you explicitly choose that action.

## Existing configuration migration

```bash
pnpm exec tsx scripts/migrate-config.ts --base /path/to/legacy --apply
```

See [docs/MIGRATION.md](docs/MIGRATION.md).

## Task execution workflow

Unchanged from the Bash engine:

| Goal | Action |
|------|--------|
| Implement issue | Label open issue `ai` |
| Review PR/MR | Label open PR/MR `ai-review` |
| New release/tag | Issue titled `new release` / `new tag` + `ai` |

Labels: `ai`, `ai-working`, `ai-pr`, `ai-failed`, `ai-review`, `ai-reviewing`, `ai-reviewed`, `ai-review-failed`.

One task per repository; other repositories run in parallel. See [docs/FEATURE_PARITY_MATRIX.md](docs/FEATURE_PARITY_MATRIX.md).

## Logs

Per-task files remain under the logs volume. The UI streams via authenticated SSE at `/api/v1/runs/:id/log-stream`.

## Backup / restore / upgrades

- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)
- Upgrade: `git pull && docker compose build && docker compose up -d`

## Security

[docs/SECURITY.md](docs/SECURITY.md)

## Worker CLI

Canonical scripts and conf **templates** live only under [`worker/`](worker/). There are no root-level copies or wrappers (see [docs/STRUCTURE_AUDIT.md](docs/STRUCTURE_AUDIT.md)).

```bash
./worker/worker.sh
./worker/run-issue.sh <project> <issue>
./worker/setup-labels.sh
```

- Runtime data override: `AI_WORKER_BASE_DIR` (conf, logs, state, `.env`)
- Code always loads from the script directory (`WORKER_CODE_DIR`)
- Templates: `worker/github-projects.conf.example`, `worker/gitlab-projects.conf.example`
- systemd / Docker invoke `worker/worker.sh` (or the synced copy under `/data/config` in Compose)

## Documentation index

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/STRUCTURE_AUDIT.md](docs/STRUCTURE_AUDIT.md)
- [docs/EXISTING_SYSTEM_AUDIT.md](docs/EXISTING_SYSTEM_AUDIT.md)
- [docs/FEATURE_PARITY_MATRIX.md](docs/FEATURE_PARITY_MATRIX.md)
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)
- [docs/MIGRATION.md](docs/MIGRATION.md)

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `/ready` 503 | `DATABASE_URL`, migrate job, `docker compose logs db` |
| Worker heartbeat stale | `docker compose logs worker`, `WORKER_INTERNAL_TOKEN`, web reachability |
| No tasks picked up | Repos enabled? Conf exported? Forge credentials? Labels present? |
| Provider unhealthy | Binary on PATH inside worker container; auth env/volumes |

## License / notice

Operate only on repositories you are authorized to automate. AI agents can modify code and open PRs/MRs.
