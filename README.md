# AI Worker Platform

Self-hosted web UI + worker for GitHub/GitLab issue implementation and PR/MR review (Cursor CLI / Claude Code).

The Bash worker runs agents. The Nuxt app handles auth, config, task history, live logs, and worker control.

## Quick start

```bash
cp .env.example .env
# Set INITIAL_ADMIN_BOOTSTRAP_SECRET (required — any random string)

docker compose up --build -d
curl -fsS http://127.0.0.1:8080/api/v1/health
```

Open `http://127.0.0.1:8080/setup`, enter the bootstrap secret, and create the first admin (username + password ≥12 chars). Compose fails if `INITIAL_ADMIN_BOOTSTRAP_SECRET` is empty.

## Environment

See [`.env.example`](.env.example).

| Variable | Required | Notes |
|----------|----------|--------|
| `INITIAL_ADMIN_BOOTSTRAP_SECRET` | Yes | Random string used once at `/setup` |
| `WORKERS` | No | Concurrent agents (default `1`). Each agent runs one issue/PR/MR; still one task per repo |
| `GITHUB_TOKEN` | No | Classic PAT with `repo`, or fine-grained: Contents + Issues + Pull requests (read/write). [Create token](https://github.com/settings/tokens) |
| `GITLAB_HOST` | No | e.g. `gitlab.com` |
| `GITLAB_TOKEN` | No | Scopes: `api` + `write_repository`. [Create token](https://gitlab.com/-/user_settings/personal_access_tokens) |

Postgres, session, encryption, and internal worker tokens are fixed in `docker-compose.yml` (DB is internal-only). Prefer connecting forge/AI credentials in the UI; compose env is a fallback.

## What you get

- Admin dashboard (Nuxt 3 + Nuxt UI)
- PostgreSQL persistence
- GitHub / GitLab connections (UI or env tokens)
- Auto repo discovery + lazy workspace clones
- Cursor + Claude CLIs in the image; keys via **Providers** UI
- Task history + SSE logs
- Worker control (reload / start / stop / restart)
- Docker Compose: `db`, `migrate`, `web`, `worker` — volumes `pgdata` + `data` (`/data`)

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Services: **web**, **worker**, **PostgreSQL**. The web process never runs AI agents.

## Connect forges

1. Open **Connections** (or set `GITHUB_TOKEN` / `GITLAB_HOST` + `GITLAB_TOKEN` in `.env`).
2. Connecting auto-registers and enables visible repos.
3. Worker polls for open `ai` / `ai-review` items; clones a workspace only when work is found.
4. New repos: every 15 minutes, or **Fetch new repos** on Repositories.

## AI providers

Built into the image (`scripts/install-ai-clis.sh`). Connect keys under **Providers**:

| Provider | Secret |
|----------|--------|
| Cursor | Cursor API key |
| Claude | Anthropic API key or Claude OAuth token |

## Task workflow

| Goal | Action |
|------|--------|
| Implement issue | Label open issue `ai` |
| Review PR/MR | Label open PR/MR `ai-review` |
| New release/tag | Issue titled `new release` / `new tag` + `ai` |

Labels: `ai`, `ai-working`, `ai-pr`, `ai-failed`, `ai-review`, `ai-reviewing`, `ai-reviewed`, `ai-review-failed`.

Raise `WORKERS` for parallel agents across different repos.

## Reverse proxy

Publish bind defaults to `127.0.0.1:8080`. Terminate TLS in front and set `APP_BASE_URL` to the public HTTPS origin.

## Development

```bash
pnpm install
# Postgres: docker compose up -d db  (or set DATABASE_URL)
pnpm db:migrate
pnpm dev
pnpm test:unit
pnpm test:worker
pnpm build
```

Optional: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` (exposes Postgres on `127.0.0.1:5432`).

## Backup / upgrade

```bash
./scripts/backup.sh
git pull && docker compose up --build -d
```

Details: [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/SECURITY.md](docs/SECURITY.md).

## Worker CLI (host)

Scripts live under [`worker/`](worker/):

```bash
./worker/worker.sh
./worker/run-issue.sh <project> <issue>
./worker/setup-labels.sh
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)
- [docs/MIGRATION.md](docs/MIGRATION.md)
- [docs/FEATURE_PARITY_MATRIX.md](docs/FEATURE_PARITY_MATRIX.md)

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Compose won't start | `.env` has non-empty `INITIAL_ADMIN_BOOTSTRAP_SECRET` |
| `/ready` 503 | `docker compose logs db migrate` |
| Worker heartbeat stale | `docker compose logs worker`, web healthy? |
| No tasks picked up | Repo enabled? Forge token scopes? `ai` / `ai-review` labels? |
| Provider unhealthy | CLI in image; key set in Providers UI |

## License / notice

Operate only on repositories you are authorized to automate. AI agents can modify code and open PRs/MRs.
