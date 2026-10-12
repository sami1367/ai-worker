# Deployment

## Prerequisites

- Ubuntu host with Docker Engine and Docker Compose v2+
- Outbound network for GitHub/GitLab and AI provider APIs
- At least 2 GB RAM recommended for concurrent agents

## Fresh install

```bash
git clone <repo-url> ai-worker-platform
cd ai-worker-platform
cp .env.example .env
# Edit .env — set strong secrets for:
#   POSTGRES_PASSWORD, NUXT_SESSION_PASSWORD, SECRET_ENCRYPTION_KEY,
#   INITIAL_ADMIN_BOOTSTRAP_SECRET, WORKER_INTERNAL_TOKEN

docker compose build
docker compose up -d

# Wait for health
curl -fsS http://127.0.0.1:8080/api/v1/health
curl -fsS http://127.0.0.1:8080/api/v1/ready

# Open http://127.0.0.1:8080/setup
# Create admin with INITIAL_ADMIN_USERNAME + INITIAL_ADMIN_BOOTSTRAP_SECRET
```

Default publish bind: `127.0.0.1:8080` (not public). Put a reverse proxy with TLS in front for remote access.

## Reverse proxy / HTTPS

Terminate TLS at Caddy/Nginx/Traefik. Forward to `127.0.0.1:8080`. Set `APP_BASE_URL` to the public HTTPS origin. Ensure `X-Forwarded-For` / `X-Forwarded-Proto` are set; cookies use `Secure` when `NODE_ENV=production`.

## Provider authentication

### GitHub

Prefer mounting authenticated `gh` config or setting `GH_TOKEN` / `GITHUB_TOKEN` in the worker environment (Compose `env_file` or secrets). Do not bake tokens into the image.

### GitLab

Set `GITLAB_HOST` and `GITLAB_TOKEN` in `.env`.

### Cursor CLI + Claude Code

Both CLIs are installed during `docker compose build` via `scripts/install-ai-clis.sh`. Connect credentials in the **Providers** UI (encrypted → `provider-credentials.env`), or set `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in Compose as a fallback. Presence of the binary alone does **not** mean authenticated.

## Updates

```bash
git pull
docker compose build
docker compose up -d
# migrate service runs once per compose up
```

## Host systemd (legacy)

The Bash worker still supports host installs via `ai-worker.service` pointing at `worker/`. Prefer Docker Compose for the full platform.

## Verification limitations

Live forge/AI task execution requires real credentials and is not covered by the default automated suite.
