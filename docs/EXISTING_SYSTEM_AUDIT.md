# Existing System Audit

**Audit date:** 2026-10-11  
**Repository:** `ai-worker` at `/home/ubuntu/dev/ai-worker`  
**Git HEAD:** `1224854` (Use JSON project registries so open-PR blocking can be disabled per repo.)  
**Baseline test:** `bash tests/related-tasks.sh` → **PASSED** (`related-tasks tests passed`, exit 0)

No live `github-projects.conf`, `gitlab-projects.conf`, or `.env` were present in the working tree (gitignored). No user data was modified or deleted during this audit.

---

## 1. Executable entry points

| Entry point | Role |
|-------------|------|
| `worker.sh` | Long-running poll loop; discovers labeled work; launches one agent per repository |
| `run-issue.sh` | GitHub issue implementation (and “new release” / “new tag” shortcut) |
| `run-github-pr-implement.sh` | GitHub PR labeled `ai` (implement follow-up on open PR) |
| `run-github-pr-review.sh` | GitHub PR labeled `ai-review` |
| `run-gitlab-issue.sh` | GitLab issue implementation (and release shortcut) |
| `run-gitlab-mr-implement.sh` | GitLab MR labeled `ai` |
| `run-gitlab-mr-review.sh` | GitLab MR labeled `ai-review` |
| `setup-labels.sh` | Creates GitHub labels; chains to GitLab setup |
| `setup-gitlab-labels.sh` | Creates GitLab labels via API |
| `ai-worker.service` | systemd unit for host install at `/home/ubuntu/ai-worker` |
| `tests/related-tasks.sh` | Unit-style test for related-service matching (no forge network) |

---

## 2. Capabilities discovered

1. **GitHub issue implement** — label `ai` → `ai-working` → branch + PR → `ai-pr` / `ai-failed`
2. **GitLab issue implement** — same label flow via GitLab API
3. **GitHub/GitLab issue answer (no-change)** — labels `ai` + `no-change` → `ai-working` → issue comment only → `ai-answered` + `no-change` / `ai-failed`
4. **GitHub PR implement** — open PR with `ai` label
5. **GitLab MR implement** — open MR with `ai` label
6. **GitHub PR AI review** — `ai-review` → `ai-reviewing` → comment → `ai-reviewed` / `ai-review-failed`
7. **GitLab MR AI review** — same pattern
8. **Cursor CLI provider** — `agent` / `cursor-agent` (`lib/ai/cursor.sh`)
9. **Claude Code CLI provider** — `claude` (`lib/ai/claude.sh`)
9b. **Codex CLI provider** — `codex` (`lib/ai/codex.sh`)
9c. **Gemini CLI provider** — `gemini` (`lib/ai/gemini.sh`)
9d. **GitHub Copilot CLI provider** — `copilot` (`lib/ai/copilot.sh`)
10. **JSON project registries** — `github-projects.conf` / `gitlab-projects.conf` with `name`, `path`, optional `block_on_open_pr`
11. **One task per repository** — in-memory PID map + `state/slots/<key>.lock` via `flock`
12. **Cross-repository concurrency** — multiple repo agents in parallel
13. **Global worker lock** — `state/worker.lock` (single supervisor)
14. **Open AI-labeled PR/MR blocking** — default on (`ai` / `ai-working` / `ai-failed` / `ai-pr`); per-project `block_on_open_pr: false`
15. **Related-service follow-ups** — parse agent JSON → open `ai` issues in other registered repos + `tasks/*.md`
16. **Release/tag shortcut** — issue title `new release` / `new tag` → bump semver, push tag, draft/upcoming release
17. **Implement merge notes** — post `.ai-pr-notes.md` content as PR/MR comment
18. **Decline unrelated tasks** — empty PR/MR with explanation when task is unusable
19. **Secret staging protection** — `ai_has_secret_files` / unstage AI artifacts
20. **Clean working tree / cleanup** — runners restore default branch on EXIT/INT/TERM
21. **Prompt templates** — `prompts/` + `prompts/snippets/` with include expansion
22. **Per-task logs** — `.log`, `.agent.ndjson`, `.agent.stderr.log`, `.result.txt`, notes, related-tasks JSON
23. **Label setup** — ten labels for GitHub and GitLab (implement, no-change Q&A, review)
24. **GitLab API client** — `lib/gitlab.sh` (issues, MRs, notes, labels, releases)
25. **GitHub via `gh` CLI** — issues, PRs, comments, releases, labels
26. **systemd host deployment** — restart on failure, 60s stop timeout, umask 0077

---

## 3. Required external commands

| Command | Required when |
|---------|----------------|
| `bash`, `git`, `jq`, `curl`, `flock`, `tee` | Always |
| `gh` | Any GitHub project registered |
| `agent` or `cursor-agent` | `AI_PROVIDER=cursor` |
| `claude` | `AI_PROVIDER=claude` |
| `codex` | `AI_PROVIDER=codex` |
| `gemini` | `AI_PROVIDER=gemini` |
| `copilot` | `AI_PROVIDER=copilot` |

---

## 4. Hardcoded host paths

Every runner and the worker set:

```bash
BASE_DIR="/home/ubuntu/ai-worker"
```

Also defaults in `lib/common.sh`, `lib/ai.sh`, `lib/prompts.sh`:

```bash
: "${BASE_DIR:=/home/ubuntu/ai-worker}"
```

`ai-worker.service` hardcodes WorkingDirectory / ExecStart / HOME / PATH for `/home/ubuntu/ai-worker`.

Example conf files use `/home/ubuntu/dev/<name>` as illustrative clone paths.

**Migration impact:** BASE_DIR must become environment-overridable (`AI_WORKER_BASE_DIR`) for Docker and relocated installs. Compatibility wrappers at old root paths are recommended for systemd users.

---

## 5. Environment variables and secrets

From `.env.example` and code:

| Variable | Purpose |
|----------|---------|
| `GITLAB_HOST` | GitLab hostname (default `git.dctm.dev`) |
| `GITLAB_TOKEN` | GitLab PAT (`api` scope) |
| `AI_PROVIDER` | `cursor` (default), `claude`, `codex`, `gemini`, or `copilot` |
| `AI_CURSOR_MODEL`, `AI_CURSOR_EXTRA_ARGS` | Cursor options |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | Claude auth |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | Codex auth |
| `GEMINI_API_KEY` | Gemini auth |
| `COPILOT_GITHUB_TOKEN` | Copilot auth (fine-grained PAT with Copilot Requests) |
| `AI_CLAUDE_MODEL`, `AI_CLAUDE_*` | Claude headless options |
| `AI_GEMINI_MODEL`, `AI_GEMINI_*` | Gemini headless options |
| `AI_COPILOT_MODEL`, `AI_COPILOT_*` | Copilot headless options |
| `AI_RELATED_TASKS_DRY_RUN` | Test-only related-task dry run |

GitHub auth is **not** in `.env`; it uses `gh auth login` (host keyring / `GH_TOKEN` if set by operator).

---

## 6–9. Authentication mechanisms

| Integration | How it works today |
|-------------|-------------------|
| **GitHub** | `gh` CLI session (`gh auth login`); runners call `gh issue/pr/...` |
| **GitLab** | `GITLAB_TOKEN` + `GITLAB_HOST` → `curl` REST API in `lib/gitlab.sh` |
| **Cursor** | CLI binary on PATH; auth is Cursor’s own login / account (not in worker `.env`) |
| **Claude Code** | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in environment |
| **Codex** | `OPENAI_API_KEY` or `CODEX_API_KEY` in environment |
| **Gemini** | `GEMINI_API_KEY` in environment |
| **GitHub Copilot** | `COPILOT_GITHUB_TOKEN` in environment (fine-grained PAT; not forge `GH_TOKEN`) |

---

## 10. Repository clones

- Operator maintains local clones at absolute paths listed in JSON conf files.
- Worker does **not** clone repositories; it validates path exists and is a git work tree (`ai_validate_project_dir`).
- Project identity for related tasks is the conf `name` string (matched case-insensitively / basename fallback).

---

## 11. Concurrency and locks

1. **Supervisor:** `flock` on `state/worker.lock` (fd 9). Second worker exits 0.
2. **Per-repo:** `state/slots/<sha256(path)>.lock` held for the duration of a launched job.
3. Supervisor releases fd 9 inside child so a restarted worker can reclaim the supervisor lock while agents continue.
4. Priority within a repo cycle: issues → PR/MR implement → reviews.

---

## 12. Stale task state recovery

- Forge labels (`ai-working`, `ai-reviewing`) are the durable “in flight” signal across restarts.
- Local `state/<project>-issue-<n>.running` files track runner presence; cleanup traps remove them.
- If a runner dies mid-task, labels may remain `ai-working` until an operator re-labels; worker will not start a new issue while `ai-working` is present.
- Repo slot locks are process-bound (`flock`); they release when the agent process exits.

---

## 13. Logs and results naming

Pattern (examples for GitHub issue):

```text
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>.log
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>.agent.ndjson
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>.agent.stderr.log
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>.prompt.txt
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>.result.txt
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>-notes.md
logs/<project>-issue-<n>-<YYYYMMDD-HHMMSS>-related-tasks.json
logs/worker.log
```

GitLab / review runners use analogous prefixes (`gitlab-issue`, `pr-review`, `mr-review`, etc.).

---

## 14. Configuration file parsing

`ai_list_project_entries` (`lib/common.sh`):

- Allows leading blank lines and `#` comments before a JSON array.
- Requires `jq`.
- Fields: `name`, `path` (or `dir`), `block_on_open_pr` (default true; accepts bool/string forms).
- Skips entries with empty name or path.

---

## 15. Host assumptions

- Absolute install path `/home/ubuntu/ai-worker`
- User `ubuntu` with HOME for `gh` credentials and AI CLI installs under `~/.local/bin` / `~/.cursor/bin`
- systemd available for production host mode
- Clones live on host filesystem at registered absolute paths
- Network access to GitHub/GitLab and AI provider APIs

---

## 16. SIGTERM and shutdown

- Runners: `trap cleanup EXIT`; `trap 'exit 130' INT`; `trap 'exit 143' TERM`; cleanup restores branch and removes running state.
- Worker: no custom SIGTERM handler; relies on bash/`KillMode=control-group` and `TimeoutStopSec=60` from systemd.
- Active agents are children; control-group kill can interrupt AI runs (labels may stay `ai-working`).

---

## 17. Related services and release automation

- **Related:** Agent writes `.ai-related-tasks.json`; runner captures it, matches registered projects, opens labeled issues (or dry-run), writes `tasks/*.md`, appends implement notes. Follow-up issues containing `<!-- ai-worker-related-task -->` do not fan out again.
- **Release:** Title match → skip AI → compute next patch from tags and forge releases → push real git tag → create GitHub draft or GitLab upcoming release → comment + close issue.

---

## 18. Behaviors needing careful migration

| Issue | Safe migration approach |
|-------|-------------------------|
| Hardcoded `BASE_DIR` | Env override + script-relative default; keep root wrappers |
| Absolute clone paths in conf | Platform-managed workspace IDs; export conf for worker |
| Host `gh` auth | Mount credential volume or `GH_TOKEN` into worker container |
| Cursor auth is interactive/host | Document volume/env for Cursor credentials; never auto-claim auth |
| SIGTERM mid-run | Graceful stop waits for idle; document interrupt risk |
| Conf reread each poll | Atomic export from DB before each poll-safe reload |
| systemd vs Docker | Document both; Docker Compose is primary for platform |

---

## Environment capabilities at audit time

| Tool | Version / status |
|------|------------------|
| Node | v22.22.1 (`/usr/bin/node`); also Cursor agent Node v24.5.0 |
| npm | 9.2.0 |
| pnpm | 12.11.2 (user install) |
| Docker | 29.7.2 |
| Docker Compose | v5.5.0 |
| gh, git, jq, curl, flock | Present |
| Live forge credentials | Not verified / not required for audit |
