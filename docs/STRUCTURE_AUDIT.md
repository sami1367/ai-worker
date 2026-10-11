# Structure Audit

**Updated:** 2026-10-11 (final root-wrapper removal)

## Decision: no root-level worker scripts

After comparing contents and tracing references, root-level worker scripts were **removed**. They were thin compatibility wrappers (`exec worker/<name>`), not independent implementations. No systemd, Docker, package, or API path required them.

Conf templates at the repository root were already removed earlier; canonical templates remain under `worker/`.

## Comparison (pre-removal)

| Root path | Counterpart | Classification | Disposition |
|-----------|-------------|----------------|------------|
| `worker.sh` | `worker/worker.sh` (1072 lines) | 9-line wrapper → `exec worker/worker.sh` | **Removed** |
| `run-issue.sh` | `worker/run-issue.sh` | wrapper | **Removed** |
| `run-github-pr-implement.sh` | `worker/run-github-pr-implement.sh` | wrapper | **Removed** |
| `run-github-pr-review.sh` | `worker/run-github-pr-review.sh` | wrapper | **Removed** |
| `run-gitlab-issue.sh` | `worker/run-gitlab-issue.sh` | wrapper | **Removed** |
| `run-gitlab-mr-implement.sh` | `worker/run-gitlab-mr-implement.sh` | wrapper | **Removed** |
| `run-gitlab-mr-review.sh` | `worker/run-gitlab-mr-review.sh` | wrapper | **Removed** |
| `setup-labels.sh` | `worker/setup-labels.sh` | wrapper | **Removed** |
| `setup-gitlab-labels.sh` | `worker/setup-gitlab-labels.sh` | wrapper | **Removed** |
| `github-projects.conf.example` | `worker/github-projects.conf.example` | identical template (already gone at root) | **Canonical in worker/** |
| `gitlab-projects.conf.example` | `worker/gitlab-projects.conf.example` | identical template (already gone at root) | **Canonical in worker/** |

## Reference audit

| Consumer | Path used | Needs root wrapper? |
|----------|-----------|---------------------|
| `ai-worker.service` | `/home/ubuntu/ai-worker/worker/worker.sh` | No |
| `docker-compose.yml` / `scripts/worker-entrypoint.sh` | `/app/worker` → `/data/config` | No |
| `package.json` `test:worker` | `worker/tests/related-tasks.sh` | No |
| API `setup-labels` | `join(workerBaseDir(), 'setup-labels.sh')` → `worker/` or `/data/config` | No |
| README (updated) | `./worker/…` only | No |

## Canonical layout

```text
worker/
  worker.sh
  run-*.sh
  setup-*.sh
  platform-wrapper.sh
  lib/  prompts/  tests/
  github-projects.conf.example
  gitlab-projects.conf.example
  logs/  state/          # placeholders; runtime often via AI_WORKER_BASE_DIR
scripts/                 # platform ops (not worker engine duplicates)
app/ server/ database/   # Nuxt platform
```

### Path variables

| Variable | Meaning |
|----------|---------|
| `WORKER_CODE_DIR` | Directory of the executing script (`lib/`, `prompts/`, sibling runners) |
| `BASE_DIR` / `AI_WORKER_BASE_DIR` | Runtime data: `*.conf`, `logs/`, `state/`, `.env` |

## Intentionally retained at repo root

Application/deployment manifests only: `package.json`, `nuxt.config.ts`, Docker files, `.env.example`, `ai-worker.service`, `README.md`, etc. **No** worker engine scripts.

## Validation (final cleanup)

| Check | Result |
|-------|--------|
| Root `*.sh` / conf examples absent | verified |
| Canonical files under `worker/` | present |
| `bash -n` on `worker/*.sh` | run in this task |
| `pnpm test:worker` | run in this task |
| Stale root-path references in code/deploy | none required after doc updates |
| `docker compose config` | run in this task |
