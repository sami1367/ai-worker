# AI Worker

Self-hosted AI agent for **GitHub** and **GitLab**: implement issues and review PRs/MRs (Cursor CLI / Claude Code).

**You do not need to clone this repository.** Only Docker is required. The app image is pulled from Docker Hub.

Image: [`sami1367/ai-worker`](https://hub.docker.com/r/sami1367/ai-worker)  
Repo: [github.com/sami1367/ai-worker](https://github.com/sami1367/ai-worker)

---

## Quick start

One command — creates the folder, downloads Compose + `.env`, **auto-generates secure secrets**, and starts the stack:

```bash
mkdir -p ai-worker && cd ai-worker && \
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml && \
curl -fsSL -o .env \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/.env.example && \
curl -fsSL https://raw.githubusercontent.com/sami1367/ai-worker/main/scripts/generate-env.sh | bash && \
docker compose up -d && \
curl -fsS http://127.0.0.1:8080/api/v1/health && \
echo && echo "INITIAL_ADMIN_BOOTSTRAP_SECRET=$(cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt)" && \
echo "Open http://127.0.0.1:8080/setup and paste that secret."
```

You do **not** fill secrets by hand. After the command finishes, the bootstrap secret is printed again and saved in:

- `INITIAL_ADMIN_BOOTSTRAP_SECRET.txt` — `cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt`
- `.env` — `grep INITIAL_ADMIN_BOOTSTRAP_SECRET .env`

## Create admin

1. Open http://127.0.0.1:8080/setup  
2. Paste `INITIAL_ADMIN_BOOTSTRAP_SECRET` (`cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt`)  
3. Choose admin username + password (min 12 characters)

Optional forge / AI tokens (`GITHUB_TOKEN`, `CURSOR_API_KEY`, …) can be added to `.env` anytime, or set later in the UI. Restart after editing `.env`:

```bash
docker compose up -d
```

### Removing `.env` after setup

On first successful start, required secrets are saved on the Docker `data` volume at `/data/config/app-secrets.env`. You may delete the host `.env` afterward if you do not need optional env overrides. Keep an offline backup of encryption/session secrets — see [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

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
| Secrets missing / insecure | Re-run: `curl -fsSL https://raw.githubusercontent.com/sami1367/ai-worker/main/scripts/generate-env.sh \| bash` |
| `migrate` fails / CREATE SCHEMA | Password mismatch or old DB volume: see [docs/SECURITY.md](docs/SECURITY.md#migrating-from-older-compose-defaults) |
| Wrong bootstrap secret | Use the value printed by `generate-env.sh` / in `.env` (not a placeholder) |

---

## Developers

Building, publishing, and local Node setup: [README.DEVELOPMENT.md](README.DEVELOPMENT.md)

Security and secret rotation: [docs/SECURITY.md](docs/SECURITY.md)
