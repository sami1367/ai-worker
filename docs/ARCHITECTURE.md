# Architecture — AI Worker Platform

## Overview

The platform wraps the existing Bash automation engine with a Nuxt 3 management application and PostgreSQL. The worker remains a separate process (Docker service or host systemd) and never runs inside the Nuxt event loop.

```text
┌─────────────┐     HTTPS/HTTP      ┌──────────────────┐
│  Browser UI │ ──────────────────► │  web (Nuxt 3)    │
└─────────────┘                     │  /api/v1/*       │
                                    └────────┬─────────┘
                                             │ SQL
                                             ▼
                                    ┌──────────────────┐
                                    │  PostgreSQL      │
                                    │  (private net)   │
                                    └────────▲─────────┘
                                             │ heartbeats,
                                             │ control_requests,
                                             │ task_runs
                                    ┌────────┴─────────┐
                                    │  worker          │
                                    │  worker.sh +     │
                                    │  platform wrapper│
                                    └────────┬─────────┘
                                             │
                         conf export / logs / workspaces
                                             │
                                    ┌────────▼─────────┐
                                    │  Persistent vols │
                                    │  config, state,  │
                                    │  logs, workspace │
                                    └──────────────────┘
```

## Process boundaries

| Service | Responsibility | Must not |
|---------|----------------|----------|
| **web** | Auth, UI, CRUD APIs, config export trigger, audit, log SSE | Run AI agents; accept arbitrary shell; mount Docker socket |
| **worker** | Poll forges, run Bash runners, hold locks, heartbeat, ack control requests | Expose public ports; write authoritative settings except status |
| **db** | Persist users, repos, settings, runs, sessions, audit | Be published publicly |

## Configuration synchronization

1. Operator changes repositories/settings in the UI → validated → PostgreSQL transaction + audit log.
2. Config sync service writes temp JSON files, validates with `jq`, atomically renames into:
   - `$AI_WORKER_BASE_DIR/github-projects.conf`
   - `$AI_WORKER_BASE_DIR/gitlab-projects.conf`
3. A `config_version` setting increments; worker records the version it loaded.
4. Active AI runs are **not** interrupted by settings changes. Changes apply to future tasks.
5. Only the web/config-sync path writes conf files. Worker is read-only for conf.

Trade-off: temporary dual representation (DB + files). Chosen because it preserves the battle-tested Bash parser with minimal risk versus rewriting conf loading in SQL.

## Worker control IPC

Table `control_requests`: `{ id, action, status, requested_by, payload, created_at, acknowledged_at, completed_at, result }`.

Allowed actions: `reload_config`, `start`, `stop`, `restart`.

Worker wrapper polls pending requests, validates action allowlist, acknowledges, performs safe operation, writes result. Stop/restart wait for idle agents when `graceful` is true (default).

## Task history

Runners continue writing filesystem logs/results. A small platform hook / watcher records `task_runs` rows with `log_path` relative to the logs volume. SSE streams append-only content from that path after authz checks — never arbitrary paths.

## Authentication

- Credentials: Argon2id password hashes in `users`
- Sessions: durable store in PostgreSQL; HttpOnly, SameSite=Lax (Strict where compatible), Secure in production
- CSRF: double-submit or Nuxt/h3 CSRF token on mutating routes
- Roles: `admin`, `operator` (read-mostly + limited actions)
- First-run: bootstrap creates one admin when no users exist; requires `INITIAL_ADMIN_USERNAME` + one-time secret or interactive setup API gated by empty-user check

## Repository directory responsibilities

| Path | Role |
|------|------|
| `app/` | Nuxt UI (pages, layouts, components, client assets under `app/assets`) |
| `server/` | API routes (`/api/v1`), middleware, domain services, server utils |
| `database/` | Drizzle schema + SQL migrations |
| `worker/` | **Canonical** Bash engine, libs, prompts, platform-wrapper, conf *templates* |
| `scripts/` | Platform ops (DB migrate, config import, backup, worker entrypoint) |
| `tests/` | Application unit/integration tests |
| `docs/` | Architecture, structure audit, ops docs |
| Root manifests | `package.json`, `nuxt.config.ts`, Docker Compose, `.env.example`, README (no worker script copies) |

See [STRUCTURE_AUDIT.md](./STRUCTURE_AUDIT.md) for duplicate disposition.

### Path variables inside the worker

- `WORKER_CODE_DIR` — scripts, `lib/`, `prompts/` (directory of the executing script).
- `BASE_DIR` / `AI_WORKER_BASE_DIR` — runtime data: conf files, `logs/`, `state/`, `.env`.

## Filesystem layout (runtime)

```text
/data/
  config/          # exported conf, .env for worker (secrets via env preferred)
  state/           # locks, running markers
  logs/            # worker + per-task logs
  workspaces/      # managed clones (repo UUID directories)
```

## Security boundaries

- No Docker socket in any service
- No privileged containers
- PostgreSQL only on internal compose network
- Web binds `127.0.0.1:8080` by default
- Path validation for workspaces; reject `..`, odd URL schemes, embedded credentials
- Logs escaped as text in UI; never executed
- Secrets encrypted at rest; never returned by API

See `docs/SECURITY.md` for the operational checklist.
