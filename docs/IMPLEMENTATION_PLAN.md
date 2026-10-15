# Implementation Plan

## Status legend

- `[x]` complete
- `[~]` partial / limited verification
- `[ ]` remaining

---

## Phase A — Audit and baseline

- [x] Inspect repository structure, scripts, libs, prompts, tests, systemd
- [x] Run baseline tests (`tests/related-tasks.sh` → passed)
- [x] Record environment tools (Node, Docker, pnpm, gh, etc.)
- [x] Write audit / parity / plan / architecture docs

## Phase B — Safe project restructuring

- [x] Create `worker/` and move scripts, lib, prompts, worker tests
- [x] `AI_WORKER_BASE_DIR` / script-relative `BASE_DIR`
- [x] Root entry points removed; use `worker/` only
- [x] systemd unit updated for `worker/`
- [x] Worker tests pass from new location

## Phase C — Application foundation

- [x] Nuxt 3 + TypeScript + pnpm
- [x] Drizzle schema + SQL migration `0000_init`
- [x] Argon2id passwords, PostgreSQL sessions, rate limit
- [x] First-run admin bootstrap
- [x] `/api/v1` structure, structured errors

## Phase D — Repository and provider management

- [x] Repository CRUD, health test, enable/disable/archive
- [x] Provider config + encrypted secrets support
- [x] Settings store
- [x] Atomic config export
- [x] `scripts/migrate-config.ts` import tool

## Phase E — Worker integration

- [x] `platform-wrapper.sh` + Compose worker entrypoint
- [x] Heartbeats + control_requests
- [x] Task run ingest API for worker
- [x] Locks/concurrency preserved in Bash worker
- [~] Full result-file → DB auto-ingestion hook (API ready; runners can POST; no in-script hook yet)

## Phase F — Full UI

- [x] Login, setup, dashboard, repositories, detail, tasks, logs (SSE), providers, settings, system, audit
- [x] Real API data; i18n scaffold (en default)

## Phase G — Docker deployment

- [x] Multi-stage Dockerfile, compose, `.env.example`, healthchecks, volumes
- [x] Verified: build, migrate, health, auth, repo persist across web recreate, worker heartbeat

## Phase H — Testing, hardening, release

- [x] Unit tests (crypto, paths, settings) — passed
- [x] Worker regression test — passed
- [x] Docker acceptance API flow — passed
- [~] Full browser e2e / live forge AI runs — require credentials (documented)
- [x] Security + ops docs

## Phase I — Forge connections, discovery, persistent workspaces

- [x] Schema migration `0001_forge_connections` (connections, discovery, workspace ops)
- [x] GitHub + GitLab OAuth (PKCE, state, encrypted tokens)
- [x] GitLab custom URL + SSRF protections / trusted host allowlist
- [x] Repository discovery, selection, registration (legacy-safe matching)
- [x] Async workspace clone/sync manager + UI status
- [x] Worker credential materialization (`forge-credentials.env`) + entrypoint source
- [x] Connections / discovery UI; repositories workspace status
- [x] Docs (README, ARCHITECTURE, SECURITY, MIGRATION) + unit tests
- [x] Default: auto-register all discovered repos; lazy clone on first AI job
- [x] 15‑min discovery scheduler + **Fetch new repos** (all connections)
- [x] Minimal repos dashboard (status / fetch; no Add selected)

## Test results (2026-10-11)

| Suite | Result |
|-------|--------|
| `pnpm test:unit` | 30 passed (was 8; connections feature added coverage) |
| `pnpm test:worker` | passed |
| `pnpm build` / `nuxt build` | succeeded |
| DB migrate `0001_forge_connections` | succeeded against running Postgres |
| `docker compose build` | succeeded (earlier acceptance) |
| Compose up + health/ready | succeeded |
| Bootstrap + login + repo CRUD + logout | succeeded |
| Web recreate persistence | succeeded |
| Worker heartbeat / poll loop | succeeded |
| Live OAuth against GitHub/GitLab | requires operator-created OAuth apps (not run here) |

## Structure cleanup (follow-up task)

- [x] Audit root vs `worker/` duplicates (`docs/STRUCTURE_AUDIT.md`)
- [x] Canonical engine in `worker/` only
- [x] Remove root conf example duplicates and root `assets/`
- [x] Remove empty unused `docker/` and `shared/`
- [x] Split `WORKER_CODE_DIR` (code) vs `BASE_DIR` (runtime data)
- [x] Fix `platform-wrapper.sh` cwd-independent start
- [x] Align package scripts / docs with actual tree
- [x] Remove root-level worker script wrappers (not required by systemd/Docker/API)

## Remaining / next steps

1. Optional: instrument Bash runners to POST `task_runs` on start/finish (API already exists).
2. [x] Install Cursor + Claude + Codex + Gemini CLIs in image (`scripts/install-ai-clis.sh`) + Providers UI connect/disconnect + `provider-credentials.env`
3. Expand automated browser e2e when desired.
4. Wire `CHECK_INTERVAL` from DB settings into worker env on export/reload (env override already works).
5. Rebuild/restart running Compose `web`/`worker` images to pick up Phase I code (migration already applied to the live DB in this environment).
6. Create GitHub/GitLab OAuth apps and set client credentials in `.env` before using Connections UI.
