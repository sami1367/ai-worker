# Deployment

## Prerequisites

Required on the host before the fresh-install command (that command does **not** install them):

- Docker Engine (daemon running)
- Docker Compose v2+ (`docker compose` plugin)
- `curl` and `bash`
- Outbound network for Docker Hub, GitHub/GitLab, and AI provider APIs
- At least 2 GB RAM recommended for concurrent agents

Verify:

```bash
docker --version && docker compose version && curl --version && docker info
```

## Fresh install (no git clone — Hub image only)

```bash
mkdir -p ai-worker && cd ai-worker && \
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml && \
curl -fsSL -o .env \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/.env.example && \
curl -fsSL https://raw.githubusercontent.com/sami1367/ai-worker/main/scripts/generate-env.sh | bash && \
docker compose up -d && \
curl -fsS http://127.0.0.1:8080/api/v1/health && \
echo && echo "INITIAL_ADMIN_BOOTSTRAP_SECRET=$(cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt)"

# Open http://127.0.0.1:8080/setup — paste the secret printed above
# Show again anytime: cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt
```

`generate-env.sh` completes the downloaded `.env.example` with cryptographically secure values. Users do not edit secrets by hand. The bootstrap secret is written to `INITIAL_ADMIN_BOOTSTRAP_SECRET.txt` and `.env`.

Compose uses `image: sami1367/ai-worker` only (no `build:`). Source code is not required on the server.

There are **no default secrets**. Containers refuse to start if required secrets are missing or match known insecure values.

Default publish bind: `127.0.0.1:8080`. Put a reverse proxy with TLS in front for remote access. Set `APP_BASE_URL` to the public HTTPS origin.

### Host `.env` optional after first start

Required secrets are copied to `/data/config/app-secrets.env` on the shared `data` volume. After a healthy first boot you may remove the host `.env` and rely on the volume (optional forge/AI tokens in `.env` would need to be re-added via the UI or a new `.env`).

## Publish image (maintainer)

```bash
docker login
./scripts/publish-image.sh        # sami1367/ai-worker:latest
./scripts/publish-image.sh 1.0.0  # also tags :latest
```

## Build from source (no Hub)

```bash
docker build -t sami1367/ai-worker:latest .
./scripts/generate-env.sh         # if .env does not exist yet
docker compose up -d
```

## Provider authentication

### GitHub

Prefer **Connections** UI, or set `GITHUB_TOKEN` in the environment. Do not bake tokens into the image.

### GitLab

Connect in the UI, or set `GITLAB_HOST` and `GITLAB_TOKEN`.

### AI providers (Cursor / Claude / Codex / Gemini / Copilot)

All five CLIs are installed in the image via `scripts/install-ai-clis.sh`. Connect credentials in the **Providers** UI, or set env vars in compose `.env`:

| Provider | Env vars |
|----------|----------|
| Cursor | `CURSOR_API_KEY` |
| Claude Code | `ANTHROPIC_API_KEY` and optional `ANTHROPIC_WORKSPACE_ID` (or `ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: wrkspc_…`), or `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `OPENAI_API_KEY` or `CODEX_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` (fine-grained PAT with **Copilot Requests**; not a classic `ghp_` token) |

DB-stored secrets from the Providers UI override env when both are set. Enable at least one provider and set a default before tasks can run.

Step-by-step auth (Claude API key vs OAuth, workspace ids, Copilot PAT): [AI_PROVIDERS.md](AI_PROVIDERS.md).

### CodeGraph

CodeGraph is installed in the image and wired into agent CLIs (MCP). Per-repository toggle defaults to **on**. The admin email collected at `/setup` is written to `codegraph.env` for optional waitlist signup on worker start. See [README — CodeGraph](../README.md#codegraph).

## Updates

```bash
docker compose pull
docker compose up -d
# migrate runs once per compose up
```

When upgrading from versions that embedded Compose secrets, follow [SECURITY.md — Migrating from older Compose defaults](SECURITY.md#migrating-from-older-compose-defaults).

## Existing installs (volume layout)

Compose uses one `data` volume at `/data` (plus `pgdata`). Fresh installs need no action. Older installs with `configdata` / `workspaces` / … need a one-time copy into `data`.

## Verification limitations

Live forge/AI task execution requires real credentials and is not covered by the default automated suite.
