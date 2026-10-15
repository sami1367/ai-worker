# Feature Parity Matrix

Maps every discovered existing capability to the AI Worker Platform. Status values: `preserved` (unchanged in worker), `adapted` (worker change for portability), `platform-new` (web/DB layer), `deferred` (documented gap).

| # | Capability | Implementation location | Migration status | Verification |
|---|------------|-------------------------|------------------|--------------|
| 1 | GitHub issue implement | `worker/run-issue.sh`, `worker/worker.sh` | preserved | Manual / mock; existing runner paths |
| 2 | GitLab issue implement | `worker/run-gitlab-issue.sh` | preserved | Manual / mock |
| 3 | GitHub PR implement | `worker/run-github-pr-implement.sh` | preserved | Manual / mock |
| 4 | GitLab MR implement | `worker/run-gitlab-mr-implement.sh` | preserved | Manual / mock |
| 5 | GitHub PR review | `worker/run-github-pr-review.sh` | preserved | Manual / mock |
| 6 | GitLab MR review | `worker/run-gitlab-mr-review.sh` | preserved | Manual / mock |
| 7 | Cursor CLI provider | `worker/lib/ai/cursor.sh` | preserved | Provider health check (detect binary) |
| 8 | Claude Code CLI provider | `worker/lib/ai/claude.sh` | preserved | Provider health check (detect binary) |
| 8b | Codex CLI provider | `worker/lib/ai/codex.sh` | new | Provider health check (detect binary); `OPENAI_API_KEY` / `CODEX_API_KEY` |
| 9 | JSON project registries | `github-projects.conf` / `gitlab-projects.conf` | adapted — DB authoritative; atomic export | Import + export tests |
| 10 | Per-repo `block_on_open_pr` (AI-labeled PR/MR only) | `lib/common.sh`, worker poll | preserved via exported conf | `tests/assignee-filter.sh` + UI setting |
| 11 | One task per repository | `worker.sh` locks | preserved | Lock behavior unchanged |
| 12 | Cross-repo concurrency | `worker.sh` agent map | preserved | Observability via task_runs |
| 13 | Global worker lock | `state/worker.lock` | preserved | Worker container single instance |
| 14 | Related-service follow-ups | `lib/related-tasks.sh` | preserved | `worker/tests/related-tasks.sh` |
| 15 | Release/tag shortcut | `run-issue.sh`, `run-gitlab-issue.sh` | preserved | Manual title shortcut |
| 16 | Implement merge notes | `lib/common.sh` | preserved | Existing runner behavior |
| 17 | Decline unrelated tasks | prompts + runners | preserved | Prompt snippets |
| 18 | Secret staging protection | `lib/common.sh` | preserved | Existing helpers |
| 19 | Cleanup / branch restore | runner traps | preserved | EXIT/INT/TERM traps |
| 20 | Prompt templates | `worker/prompts/` seed → `prompt_templates` DB + UI | preserved + editable | Worker fetches from DB each job; seed files fallback |
| 21 | Per-task log files | `logs/` naming | preserved + DB metadata | task_runs.log_ref |
| 22 | Label setup (GH/GL) | `setup-labels.sh`, `setup-gitlab-labels.sh` | preserved + UI action | API triggers scripts |
| 22b | Forge webhooks (label wake) | `server/services/webhooks.ts`, worker wake-poll | platform-new — optional | Unit tests + Setup webhooks UI |
| 23 | GitLab API client | `lib/gitlab.sh` | preserved | Token via env/secrets |
| 24 | GitHub via `gh` | runners | preserved | GH_TOKEN / gh auth volume |
| 25 | systemd unit | `ai-worker.service` | adapted — points at wrappers / Docker preferred | Docs migration |
| 26 | Configurable BASE_DIR | hardcoded `/home/ubuntu/ai-worker` | adapted — `AI_WORKER_BASE_DIR` | Container + host tests |
| 27 | Web dashboard | — | platform-new — implemented | Docker acceptance + UI |
| 28 | PostgreSQL persistence | database/ | platform-new — implemented | Migrations + Docker acceptance |
| 29 | Session auth | server/services/auth.ts | platform-new — implemented | Unit + Docker bootstrap/login |
| 30 | Config import tool | scripts/migrate-config.ts | platform-new — implemented | CLI dry-run/apply |
| 31 | Worker control IPC | control_requests + platform-wrapper | platform-new — implemented | Docker reload request |
| 32 | Live log streaming | SSE API + UI | platform-new — implemented | Authz path; live AI run needs credentials |
| 33 | Docker Compose deploy | Dockerfile + compose | platform-new — verified | build/up/health/auth/persist |

## Intentionally not rewritten

Bash runners remain the execution engine. The web app manages configuration, observation, and lifecycle — it does not reimplement AI task execution in TypeScript.
