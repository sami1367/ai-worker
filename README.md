# AI Worker

Self-hosted AI agent for **GitHub** and **GitLab**: implement issues and review PRs/MRs (Cursor CLI / Claude Code).

**You do not need to clone this repository.** Only Docker is required. The app image is pulled from Docker Hub.

Image: [`sami1367/ai-worker`](https://hub.docker.com/r/sami1367/ai-worker)  
Repo: [github.com/sami1367/ai-worker](https://github.com/sami1367/ai-worker)

---

## Quick start

One command — creates the folder, downloads `docker-compose.yml`, and copies `.env` from `.env.example`:

```bash
mkdir -p ai-worker && cd ai-worker && \
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml && \
curl -fsSL -o .env \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/.env.example
```

Edit `.env` if you want (optional — defaults work), then start:

```bash
docker compose up -d
curl -fsS http://127.0.0.1:8080/api/v1/health
```

## Create admin

1. Open http://127.0.0.1:8080/setup  
2. Bootstrap secret: value from `.env`, or **`changeme`** if unset  
3. Choose admin username + password (min 12 characters)

Forge and AI provider tokens can stay in `.env` next to `docker-compose.yml` — you do not need the Providers UI if those are set. Restart (`docker compose up -d`) after changing `.env`.

---

## Everyday use

| Goal | Action |
|------|--------|
| Implement an issue | Add label `ai` |
| Review a PR/MR | Add label `ai-review` |

Update later:

```bash
docker compose pull
docker compose up -d
```

Stop:

```bash
docker compose down
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `curl` 404 on GitHub raw URL | Repo must be **public** (Settings → Danger Zone → Change visibility) |
| Cannot pull image | Is `sami1367/ai-worker:latest` on Hub? Try `docker pull sami1367/ai-worker:latest` |
| `migrate` fails / CREATE SCHEMA | Old DB volume: `docker compose down -v && docker compose up -d` (deletes data) |
| Wrong bootstrap secret | Use `changeme`, or the value you set in `.env` |

---

## Developers

Building, publishing, and local Node setup: [README.DEVELOPMENT.md](README.DEVELOPMENT.md)
