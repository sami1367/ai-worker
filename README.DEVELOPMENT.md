# AI Worker — development & publishing

Maintainer notes. Public users should follow [README.md](README.md) (no git clone).

## Publish image to Docker Hub

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
docker build -t sami1367/ai-worker:latest .
./scripts/generate-env.sh    # required — no Compose default secrets
docker compose up -d
```

## Local Node development

```bash
pnpm install
./scripts/generate-env.sh    # creates .env with secure secrets
docker compose up -d db
# Point DATABASE_URL at localhost if using docker-compose.dev.yml
pnpm db:migrate
pnpm dev
```

Do not use `changeme` or other placeholder secrets. Unit tests do not require a full `.env`; integration tests need `DATABASE_URL`.

Optional: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` (exposes Postgres on `127.0.0.1:5432`).

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)

## Secrets in images

Local `.env` is excluded by `.dockerignore` and is never pushed to Hub. Do not commit real `.env` files.

### Project chat

The **Project chat** sidebar entry (`/project-chat`) opens repository conversations
separately from Create Tasks. Each signed-in user has their own saved conversations
per repository, with a New chat button and history for reopening earlier chats.
Chats use the repository's configured AI provider and refresh code context for each
question. Opening a chat queues an initial clone when needed and prepares CodeGraph
when enabled for that repository. If CodeGraph is unavailable, answers use the
sampled file tree and key manifests; this context is not a full repository snapshot.
Chats do not create forge issues or run implementation tasks.

Apply migration `0012_project_chat_sessions` with `pnpm db:migrate` before running
the updated application. This requires the deployment's `DATABASE_URL`.

Both Project Chat and Create Tasks render saved messages as Markdown, including
headings, emphasis, lists, tables, links, and highlighted fenced code blocks.
Top-level fenced `mermaid` blocks render as diagrams in the browser. Invalid
or unavailable diagrams retain their readable source. Markdown HTML is escaped;
Mermaid uses strict mode and its SVG output is sanitized. Diagram scripts, click
handlers, and embedded HTML are not supported. AI prompts describe these formats
and encourage diagrams when useful for explaining project architecture or flows.

### Microservice groups

**Microservices → Group chat** (`/microservices`) provides named groups of 2–20
registered repositories. Assign preset or custom role labels and descriptions to
each project. Groups and their conversations are private to their creator; saved
conversations can be resumed or a new chat started for the same group.

Apply migration `0013_microservice_groups` with `pnpm db:migrate` before starting
the updated app. The background preparer uses the existing authenticated clone
queue for missing source workspaces, then creates independent sibling Git clones
under `$WORKSPACE_ROOT/microservices-<group-id>/<service-name>/`. Duplicate service
names receive a repository ID suffix. `services.json` records each project's labels,
description, and commit. Source worker checkouts are not moved or relinked.

CodeGraph indexes the common group directory, including all selected repositories,
when enabled in the group settings. This setting controls the separate group index
and does not change per-repository worker settings. If indexing is unavailable,
chat remains available with sampled code context from every service. The UI shows
workspace and CodeGraph status, preparation errors, and the snapshot date.

**Sync workspace** refreshes source repositories through the authenticated workspace
queue, updates the group clones, and rebuilds its index. The preparer resumes queued
work after application restarts. Failed clones require an explicit retry. Editing
group membership or labels rebuilds group context and preserves chat history;
settings apply to future replies. Chats use the first selected project's preferred
AI provider, with the existing provider fallback behavior, and include service
prefixes, labels, descriptions, and a fair context budget for every project.
