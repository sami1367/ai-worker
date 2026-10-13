# AI Worker (execution engine)

This directory is the **canonical** Bash automation engine for the AI Worker Platform.

## Entry points

| Script | Role |
|--------|------|
| `worker.sh` | Poll loop (`POLL_CONCURRENCY` parallel repo checks; `WORKERS` concurrent agents; one task each; one per repo) |
| `run-issue.sh` / `run-gitlab-issue.sh` | Issue implement (+ release shortcut) |
| `run-github-pr-implement.sh` / `run-gitlab-mr-implement.sh` | PR/MR implement |
| `run-github-pr-review.sh` / `run-gitlab-mr-review.sh` | PR/MR review |
| `setup-labels.sh` / `setup-gitlab-labels.sh` | Label bootstrap |
| `platform-wrapper.sh` | Docker/platform heartbeat + control_requests |

Invoke these scripts from this directory (or via absolute path). Root-level duplicates/wrappers are **not** retained.

## Paths

| Variable | Meaning | Default |
|----------|---------|---------|
| `WORKER_CODE_DIR` | Code: this directory (`lib/`, `prompts/`, sibling scripts) | Script directory |
| `AI_WORKER_BASE_DIR` / `BASE_DIR` | Runtime: `*.conf`, `logs/`, `state/`, `.env` | Same as code dir |
| `POLL_CONCURRENCY` | Repos polled in parallel per pass (forge label checks) | `5` |
| `WORKERS` | Max concurrent agents (still one task per repo) | `1` |
| `CHECK_INTERVAL` | Idle sleep between poll cycles (seconds) | `30` |
| `REPO_CLAIM_TTL_SECONDS` | Multi-worker Postgres lease before label claim | `10` |

Configuration templates: `github-projects.conf.example`, `gitlab-projects.conf.example`.

In Docker Compose, `scripts/worker-entrypoint.sh` syncs this tree into `/data/config` and sets `AI_WORKER_BASE_DIR` there. PostgreSQL (via the web app) is the authoritative source for repository settings; conf files are an atomic export for the Bash parser.

## Tests

```bash
bash tests/related-tasks.sh
# or from repo root:
pnpm test:worker
```
