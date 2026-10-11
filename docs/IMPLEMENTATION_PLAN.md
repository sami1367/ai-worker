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

## Test results (2026-10-11)

| Suite | Result |
|-------|--------|
| `pnpm test:unit` | 8 passed |
| `pnpm test:worker` | passed |
| `pnpm build` | succeeded |
| `docker compose build` | succeeded |
| Compose up + health/ready | succeeded |
| Bootstrap + login + repo CRUD + logout | succeeded |
| Web recreate persistence | succeeded |
| Worker heartbeat / poll loop | succeeded |

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
2. Pin/install Cursor + Claude CLIs in image when reproducible installers are available.
3. Expand automated browser e2e when desired.
4. Wire `CHECK_INTERVAL` from DB settings into worker env on export/reload (env override already works).
