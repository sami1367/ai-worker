# AI Worker Platform

Self-hosted web UI + worker for GitHub/GitLab issue implementation and PR/MR review (Cursor CLI / Claude Code).

## Run (no git clone — image only)

You do **not** need the source code. Only Docker + this compose file (it pulls `sami1367/ai-worker` from Hub):

```bash
mkdir ai-worker && cd ai-worker
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml

docker compose up -d
curl -fsS http://127.0.0.1:8080/api/v1/health
```

Open `http://127.0.0.1:8080/setup` — bootstrap secret default is **`changeme`**. Create admin (password ≥12 chars).

No `.env` and no git clone. Optional overrides: create a `.env` next to the compose file (see [`.env.example`](.env.example) in the repo if you want names).

Image: [`sami1367/ai-worker`](https://hub.docker.com/r/sami1367/ai-worker)

## Publish image (you — build locally, push to Hub)

```bash
docker login
./scripts/publish-image.sh          # :latest
./scripts/publish-image.sh 1.0.0    # :1.0.0 and :latest
```

Other Hub namespace:

```bash
AI_WORKER_IMAGE=myuser/ai-worker ./scripts/publish-image.sh
```

## Build from this repo (no Hub)

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d
```

## Environment (all optional)

Defaults live in `docker-compose.yml`. Override via shell or `.env`:

| Variable | Default | Notes |
|----------|---------|--------|
| `INITIAL_ADMIN_BOOTSTRAP_SECRET` | `changeme` | Used once at `/setup` |
| `WORKERS` | `1` | Concurrent agents (one task each; one per repo) |
| `GITHUB_TOKEN` | empty | Classic `repo`, or fine-grained Contents+Issues+PRs write. [Create](https://github.com/settings/tokens) |
| `GITLAB_HOST` / `GITLAB_TOKEN` | empty | Scopes `api` + `write_repository`. [Create](https://gitlab.com/-/user_settings/personal_access_tokens) |
| `APP_BASE_URL` | `http://127.0.0.1:8080` | Public URL behind TLS proxy |
| `AI_WORKER_IMAGE` | `sami1367/ai-worker:latest` | Image to pull |

Postgres and app crypto secrets are fixed in compose (DB is internal-only). Prefer connecting forge/AI credentials in the UI.

## What you get

- Admin dashboard (Nuxt 3)
- PostgreSQL + migrate + web + worker
- Volumes: `pgdata`, `data` (`/data`)
- Cursor + Claude CLIs in the image; keys via **Providers** UI

## Task workflow

| Goal | Action |
|------|--------|
| Implement issue | Label open issue `ai` |
| Review PR/MR | Label open PR/MR `ai-review` |
| New release/tag | Issue titled `new release` / `new tag` + `ai` |

## Development (Node)

```bash
pnpm install
docker compose up -d db
pnpm db:migrate
pnpm dev
```

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Image pull fail | Image published? `docker pull sami1367/ai-worker:latest` |
| `migrate` exit 1 / CREATE SCHEMA | Old Postgres volume password mismatch → `docker compose down -v && docker compose up -d` (wipes DB) |
| `/setup` rejects secret | Default is `changeme` unless you overrode it |
| `/ready` 503 | `docker compose logs db migrate` |
| No tasks | Forge token in UI/env? `ai` / `ai-review` labels? |

Operate only on repositories you are authorized to automate.
