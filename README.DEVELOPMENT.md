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

Group forms render without waiting for repository loading and show the first page
immediately; remaining pages load with bounded concurrency. Group checkouts are
prepared three at a time, with redundant fetches skipped for unchanged snapshots.
Once all checkouts are ready, chat is available while CodeGraph finishes indexing.
Existing group indexes use incremental sync, falling back to a full rebuild only
if sync fails. Group editing/sync stays locked while indexing is in progress.

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

### Chat and Work modes

Project Chat and microservice chats start in **Chat** mode. Switching to **Work**
shows **Generate tasks** (or **Regenerate tasks**) and **Approve & start work**.
Generation replaces the local draft from the current conversation and repository
context; it does not create GitHub/GitLab issues. If the conversation, group, or
repository configuration changes, regenerate before approving. Approval freezes
that plan and its repository commits. Duplicate approval cannot enqueue the same
plan twice, and only one work run per chat can be active.

Apply migration `0014_chat_work` with `pnpm db:migrate`, then restart the web and
worker services. This migration also normalizes existing project-chat update
timestamps to JavaScript's millisecond precision for reliable optimistic updates.
The existing platform worker wrapper now runs a chat-work queue consumer alongside
the forge-label worker. On host installs, run `worker/platform-wrapper.sh` with
`WEB_INTERNAL_URL` and `WORKER_INTERNAL_TOKEN` configured; the legacy standalone
`worker.sh` loop handles only forge tasks.

Approved work runs in the background in
`$WORKSPACE_ROOT/chat-work-<run-id>/<service-directory>/`, using independent clones
of all selected repositories and a separate branch in each repository. Single
projects start from their configured remote default branch; microservice groups
start from the prepared group snapshot. One coding agent sees the whole directory
and the approved plan, including which repositories it may edit. Configured AI
CLI providers, model settings, and the existing agent credential isolation are
reused. In bubblewrap mode the sibling repositories' Git metadata is read-only to
the agent. Chat work has a dedicated consumer slot per platform worker. The default
agent timeout is two hours (`CHAT_WORK_TIMEOUT_SECONDS` can override it).

The trusted orchestrator commits, pushes the run branch without force, and opens
one PR/MR for each changed repository covered by the plan. Unchanged repositories
produce no empty requests. Changes to context-only repositories or unexpected Git
history stop publication. Forge publishing uses each repository's own connection;
no AI labels are attached, no forge issues are created, and no requests are merged
automatically. Repository `forcePushToDefault` settings do not apply to chat work.

**Chat work** (`/chat-work`) lists ongoing and finished runs, affected services,
agent output, publication results, and links back to the exact conversation.
The conversation also shows a progress/results link in either mode. You may leave
the page or return to Chat mode while an approved run continues. Lost worker leases mark runs interrupted; completed code can retry publishing
without rerunning the AI. Partial publication saves per-repository commits and
request URLs, so retries reuse the same branch/request and skip successful services.

### UI navigation and read caching

Page data uses Nuxt's lazy loaders so sidebar navigation renders the destination
while its requests are running. Auth checks are reused for up to 60 seconds within
the current browser session; API authorization still runs on every request.
Readiness refreshes after connection/repository/provider edits and once a minute
while the tab is visible, rather than on every route change.

Docker Compose includes a private, disposable Redis cache (128 MiB, LRU eviction,
no host port or persistence). For local Nuxt development, optionally set
`REDIS_URL=redis://127.0.0.1:6379`. Without it, or during Redis outages, the app uses
process memory capped at 500 entries. Redis failures have short timeouts and do
not prevent requests from reaching their data source.

- GitHub/GitLab branch lists: 30-second TTL. Repository and connection access are
  checked before reading the cache; the current default branch is applied live.
- AI account/CLI snapshots: fresh for 2 minutes, then served for up to 10 more
  minutes while refreshing in the background. A cold cache returns no account
  snapshot immediately and fills it in the background. The dashboard loads
  completed snapshots through a separate lazy request, so account probes cannot
  delay operational task/queue data.
- Keys hash the host, project, and credential identity so changing credentials
  cannot reuse another connection's results. Tokens are never cache values.
  These caches contain account metadata; keep Redis private.
- Failed loads are retried on a later request. Concurrent reads within a web
  process share one in-flight load; separate processes share completed Redis
  entries. This does not cache AI generation responses or mutation requests.

To clear shared cached reads, delete only keys matching `ai-worker:reads:v1:*`
from your Redis instance and restart web processes to clear their local caches.
After applying these source changes, rebuild/redeploy the web image and start the
Redis service; `docker compose up -d` alone uses the published image unless you
have built and selected a new `AI_WORKER_IMAGE`.


### Repairing a group CodeGraph index

Use **Retry CodeGraph** on the group chat page to rebuild just the index without
fetching or recloning repositories. The app checks `codegraph status --json` before
and after indexing: an incomplete `.codegraph/` directory triggers initialization,
an interrupted build triggers reindexing, and a healthy index uses incremental sync.
Parent-directory indexes never count as the selected group's index.

Index output is streamed with a bounded diagnostic tail, rather than terminating
when a buffered output limit is exceeded. The default indexing timeout is 30 minutes
(`CODEGRAPH_INDEX_TIMEOUT_SECONDS`, range 60–7200 seconds). Active indexing renews
the group lease while it runs. `CODEGRAPH_BIN` can specify the CLI executable path
inside the web runtime; the launcher also checks common user/system binary paths.

Failures show the actual sanitized command error on the group page and in the web
logs. The group workspace retains `.codegraph-preparation.log` with the recent
index/status output. Missing executables, timeouts, termination signals, and
incomplete index state are distinguished; `ready` is set only after verification.
