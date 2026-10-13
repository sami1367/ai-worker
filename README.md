# AI Worker

Self-hosted AI agent for **GitHub** and **GitLab**: implement issues and review PRs/MRs (Cursor CLI / Claude Code).

**You do not need to clone this repository.** Only Docker is required. The app image is pulled from Docker Hub.

Image: [`sami1367/ai-worker`](https://hub.docker.com/r/sami1367/ai-worker)

---

## 1. Download compose

```bash
mkdir ai-worker && cd ai-worker

curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml
```

## 2. Optional `.env`

Compose already has defaults. Create a `.env` only if you want to override them (same folder as `docker-compose.yml`):

```bash
cat > .env <<'EOF'
# First-admin setup secret (default in compose is changeme)
INITIAL_ADMIN_BOOTSTRAP_SECRET=changeme

# How many issues/PRs can run at once (default 1)
WORKERS=1

# Optional forge tokens (or connect later in the UI)
# GitHub: https://github.com/settings/tokens  (classic scope: repo)
GITHUB_TOKEN=

# GitLab: https://gitlab.com/-/user_settings/personal_access_tokens
# Scopes: api + write_repository
GITLAB_HOST=gitlab.com
GITLAB_TOKEN=

# Optional AI provider keys (or connect later in the UI)
# Cursor: https://cursor.com/dashboard → API Keys
CURSOR_API_KEY=

# Claude: Anthropic API key and/or Claude Code OAuth token
ANTHROPIC_API_KEY=
# CLAUDE_CODE_OAUTH_TOKEN=
EOF
```

## 3. Run

```bash
docker compose up -d
curl -fsS http://127.0.0.1:8080/api/v1/health
```

## 4. Create admin

1. Open http://127.0.0.1:8080/setup  
2. Bootstrap secret: value from `.env`, or **`changeme`** if you skipped `.env`  
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
| Cannot pull image | Is `sami1367/ai-worker:latest` on Hub? Try `docker pull sami1367/ai-worker:latest` |
| `migrate` fails / CREATE SCHEMA | Old DB volume: `docker compose down -v && docker compose up -d` (deletes data) |
| Wrong bootstrap secret | Use `changeme`, or the value you set in `.env` |

---

## Developers

Building, publishing, and local Node setup: [README.DEVELOPMENT.md](README.DEVELOPMENT.md)
