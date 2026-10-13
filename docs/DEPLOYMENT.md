# Deployment

## Prerequisites

- Docker Engine + Docker Compose v2+
- Outbound network for GitHub/GitLab and AI provider APIs
- At least 2 GB RAM recommended for concurrent agents

## Fresh install (no git clone — Hub image only)

```bash
mkdir ai-worker && cd ai-worker
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml

docker compose up -d

curl -fsS http://127.0.0.1:8080/api/v1/health
curl -fsS http://127.0.0.1:8080/api/v1/ready

# Open http://127.0.0.1:8080/setup — bootstrap secret default: changeme
```

Compose uses `image: sami1367/ai-worker` only (no `build:`). Source code is not required on the server.

Default publish bind: `127.0.0.1:8080`. Put a reverse proxy with TLS in front for remote access. Set `APP_BASE_URL` to the public HTTPS origin.

## Publish image (maintainer)

```bash
docker login
./scripts/publish-image.sh        # sami1367/ai-worker:latest
./scripts/publish-image.sh 1.0.0  # also tags :latest
```

## Build from source (no Hub)

```bash
docker build -t sami1367/ai-worker:latest .
docker compose up -d
```

## Provider authentication

### GitHub

Prefer **Connections** UI, or set `GITHUB_TOKEN` in the environment. Do not bake tokens into the image.

### GitLab

Connect in the UI, or set `GITLAB_HOST` and `GITLAB_TOKEN`.

### Cursor CLI + Claude Code

Installed in the image. Connect credentials in **Providers** UI.

## Updates

```bash
docker compose pull
docker compose up -d
# migrate runs once per compose up
```

## Existing installs (volume layout)

Compose uses one `data` volume at `/data` (plus `pgdata`). Fresh installs need no action. Older installs with `configdata` / `workspaces` / … need a one-time copy into `data`.

## Verification limitations

Live forge/AI task execution requires real credentials and is not covered by the default automated suite.
