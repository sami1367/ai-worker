# AI Worker

Server-side automation that watches **GitHub** and **GitLab** issues, runs the Cursor Agent to implement them, and opens pull/merge requests for human review. On GitLab it can also **AI-review merge requests** when you add a label.

Label an issue with `ai` → worker implements it on a branch → opens a PR (GitHub) or MR (GitLab). Label a GitLab MR with `ai-review` → worker reviews the diff and posts an MR comment. It never merges automatically.

---

## How to run this app

### One-time setup

```bash
cd /home/ubuntu/ai-worker

# 1) GitHub auth (skip if you only use GitLab)
gh auth login

# 2) GitLab auth (skip if you only use GitHub)
cp .env.example .env
nano .env
# Set:
#   GITLAB_HOST=git.dctm.dev
#   GITLAB_TOKEN=<personal access token with api scope>

# 3) Register local clones (see sections below)
nano projects.conf
nano gitlab-projects.conf

# 4) Create issue + MR-review labels on all registered repos
./setup-labels.sh
```

### Run in the foreground (manual / debug)

```bash
cd /home/ubuntu/ai-worker
./worker.sh
```

- Logs: `logs/worker.log`
- Lock: `state/worker.lock` (only one worker at a time)
- Stop: `Ctrl+C`

### Run a single issue or MR review (without the poll loop)

```bash
# GitHub issue
./run-issue.sh <project-name> <issue-number>

# GitLab issue
./run-gitlab-issue.sh <project-name> <issue-iid>

# GitLab MR AI review
./run-gitlab-mr-review.sh <project-name> <merge-request-iid>
```

Examples:

```bash
./run-issue.sh insta2site-api 1
./run-gitlab-issue.sh bale-service 12
./run-gitlab-mr-review.sh bale-service 34
```

### Queue work

- **Implement an issue:** on any registered repo, open an issue and add the **`ai`** label.
- **Review a GitLab MR:** open (or edit) a merge request and add the **`ai-review`** label.

Within about 60 seconds the worker should pick it up.

---

## Add as a Linux systemd service

Use this so the worker starts on boot and restarts after failures.

### 1. Install the unit file

A unit file lives in this repo as [`ai-worker.service`](ai-worker.service).

```bash
sudo cp /home/ubuntu/ai-worker/ai-worker.service /etc/systemd/system/ai-worker.service
sudo systemctl daemon-reload
sudo systemctl enable ai-worker
sudo systemctl start ai-worker
```

### 2. Check status and logs

```bash
sudo systemctl status ai-worker
sudo journalctl -u ai-worker -f
tail -f /home/ubuntu/ai-worker/logs/worker.log
```

### 3. Common service commands

```bash
sudo systemctl stop ai-worker
sudo systemctl start ai-worker
sudo systemctl restart ai-worker
sudo systemctl disable ai-worker   # stop starting on boot
```

### 4. After you change scripts or config

```bash
# Config / scripts under /home/ubuntu/ai-worker — restart the service
sudo systemctl restart ai-worker

# Only if you edited /etc/systemd/system/ai-worker.service
sudo systemctl daemon-reload
sudo systemctl restart ai-worker
```

### Unit file contents (reference)

```ini
[Unit]
Description=Cursor AI Issue Worker (GitHub + GitLab)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/ai-worker
Environment=HOME=/home/ubuntu
Environment=PATH=/home/ubuntu/.local/bin:/home/ubuntu/.cursor/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/ubuntu/ai-worker/worker.sh
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=60
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Notes:

- `PATH` must include the Cursor CLI (`agent` / `cursor-agent`), usually under `~/.local/bin`.
- The service runs as user `ubuntu` so it can use that user’s `gh` auth, SSH keys, and `.env`.
- Do **not** run `./worker.sh` manually while the systemd unit is active (the lock file will block the second process).

---

## Add a GitHub project

1. Clone the repo locally (if needed):

   ```bash
   git clone git@github.com:ORG/REPO.git /home/ubuntu/dev/my-app
   ```

2. Ensure `origin` points at GitHub and default branch is `main`.

3. Add one line to [`projects.conf`](projects.conf):

   ```conf
   my-app=/home/ubuntu/dev/my-app
   ```

4. Create labels on that repo:

   ```bash
   cd /home/ubuntu/ai-worker
   ./setup-labels.sh
   ```

5. Restart the worker if it is running under systemd:

   ```bash
   sudo systemctl restart ai-worker
   ```

6. On GitHub: open an issue → add label **`ai`**.

Requirements: `gh` authenticated with access to the repo (`gh auth login`, `gh auth status`).

---

## Add a GitLab project

1. Clone from your company GitLab host:

   ```bash
   git clone git@git.dctm.dev:group/subgroup/my-service.git /home/ubuntu/dev/my-service
   ```

2. Ensure `origin` is the GitLab remote and default branch is `main`.

3. Add one line to [`gitlab-projects.conf`](gitlab-projects.conf) (**not** `projects.conf`):

   ```conf
   my-service=/home/ubuntu/dev/my-service
   ```

4. Configure token (once):

   ```bash
   cd /home/ubuntu/ai-worker
   cp -n .env.example .env
   nano .env
   ```

   ```bash
   GITLAB_HOST=git.dctm.dev
   GITLAB_TOKEN=glpat-xxxxxxxx
   ```

   Token needs **`api`** scope (read/write issues, labels, merge requests). Git push still uses your SSH key / git credentials.

5. Create labels:

   ```bash
   ./setup-gitlab-labels.sh
   # or for both forges:
   ./setup-labels.sh
   ```

6. Restart the service:

   ```bash
   sudo systemctl restart ai-worker
   ```

7. On GitLab: open an issue → add label **`ai`**.

Without `GITLAB_TOKEN`, GitHub still works; GitLab projects are skipped with a warning.

---

## How it works

```mermaid
flowchart LR
  A[Issue labeled ai] --> B[worker.sh polls]
  B --> C[Label: ai-working]
  C --> D{Forge}
  D -->|GitHub| E[run-issue.sh]
  D -->|GitLab| F[run-gitlab-issue.sh]
  E --> G[Cursor Agent]
  F --> G
  G --> H[Commit + push]
  H --> I{Forge}
  I -->|GitHub| J[PR via gh]
  I -->|GitLab| K[MR via API]
  J --> L{Success?}
  K --> L
  L -->|Yes| M[Label: ai-pr]
  L -->|No| N[Label: ai-failed]
```

1. **`worker.sh`** polls every 60 seconds.
2. Priority per cycle (one task only): GitHub issues → GitLab issues → GitLab MR reviews.
3. Issue path: label becomes `ai-working` → Cursor implements → opens a PR/MR → `ai-pr` or `ai-failed`.
4. MR review path: label becomes `ai-reviewing` → Cursor reviews → posts an MR comment → `ai-reviewed` or `ai-review-failed`.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Git** | Default branch `main` |
| **GitHub CLI** (`gh`) | For GitHub projects |
| **curl** + **jq** | GitLab REST API |
| **flock** | Single worker process |
| **Cursor CLI** | `agent` or `cursor-agent` on `PATH` |
| **GITLAB_TOKEN** | `api` scope; GitLab only |

## Labels

### Issue labels (GitHub and GitLab)

Create these on every registered repository before queuing issues.

| Label | Color | Who sets it | Meaning |
|-------|-------|-------------|---------|
| `ai` | Green (`0E8A16`) | **You** (manually) | Queue this open issue for the worker |
| `ai-working` | Yellow (`FBCA04`) | Worker | Issue is being processed right now |
| `ai-pr` | Blue (`1D76DB`) | Worker | Finished successfully; a PR (GitHub) or MR (GitLab) was opened |
| `ai-failed` | Red (`D73A4A`) | Worker | Run failed — check logs before retrying |

Only **`ai`** is applied by hand for issues.

```
ai  →  ai-working  →  ai-pr      (success — PR/MR created)
                 ↘  ai-failed   (failure — not auto-retried)
```

### GitLab MR review labels

These are **GitLab-only** and apply to **merge requests** (not issues).

| Label | Color | Who sets it | Meaning |
|-------|-------|-------------|---------|
| `ai-review` | Purple (`7057FF`) | **You** (manually) | Queue this open MR for an AI review comment |
| `ai-reviewing` | Yellow (`FBCA04`) | Worker | MR is being reviewed right now |
| `ai-reviewed` | Green (`0E8A16`) | Worker | Review comment was posted |
| `ai-review-failed` | Red (`D73A4A`) | Worker | Review run failed — check logs before retrying |

```
ai-review  →  ai-reviewing  →  ai-reviewed        (success — comment posted)
                           ↘  ai-review-failed   (failure — not auto-retried)
```

| Step | Labels |
|------|--------|
| You queue a review | Add `ai-review` on an **open** merge request |
| Worker starts | Removes `ai-review`, adds `ai-reviewing` |
| Success | Removes `ai-reviewing`, adds `ai-reviewed`, posts MR note |
| Failure | Removes `ai-reviewing`, adds `ai-review-failed` |
| Retry | Check logs, then add `ai-review` again |

Failed issues/reviews are **not** re-queued automatically (avoids infinite loops).

### Create labels on all registered repos

From the worker directory, after `projects.conf` / `gitlab-projects.conf` (and `.env` for GitLab) are configured:

```bash
cd /home/ubuntu/ai-worker

# Both GitHub and GitLab (recommended)
./setup-labels.sh
```

What that does:

- **GitHub:** uses `gh label create ... --force` for every path in `projects.conf`
- **GitLab:** calls `./setup-gitlab-labels.sh`, which creates or updates labels via the GitLab API for every path in `gitlab-projects.conf`

### Create labels on GitHub only

Requirements: `gh` installed and authenticated (`gh auth login`).

```bash
cd /home/ubuntu/ai-worker
# Ensure the repo is listed in projects.conf, then:
./setup-labels.sh
```

Or create them manually in the GitHub UI: **Issues → Labels → New label**, using the names and colors in the table above.

### Create labels on GitLab only

Requirements: `.env` with `GITLAB_HOST` and `GITLAB_TOKEN` (`api` scope).

```bash
cd /home/ubuntu/ai-worker
cp -n .env.example .env
# Edit .env and set GITLAB_TOKEN

./setup-gitlab-labels.sh
```

Or create them manually in GitLab: **Project → Manage → Labels → New label**, using the same names and colors.

### How to use labels day to day

**Issues (implement):**

1. Open (or create) an issue on a registered GitHub or GitLab project.
2. Add the **`ai`** label only.
3. Wait (~60s). Labels become **`ai-working`**, then **`ai-pr`** or **`ai-failed`**.
4. On success, review the PR/MR. On failure, inspect `logs/` and add **`ai`** again to retry.

**GitLab merge requests (AI review):**

1. Open an MR on a registered GitLab project.
2. Add the **`ai-review`** label.
3. Wait (~60s). Labels become **`ai-reviewing`**, then **`ai-reviewed`** or **`ai-review-failed`**.
4. On success, read the AI comment on the MR. On failure, inspect `logs/` and add **`ai-review`** again to retry.

If labels are missing on a repo, the worker cannot find or update the item — run the setup script again after registering a new project.

## What Cursor does vs. what the scripts do

**Issue runs:** Cursor implements the issue and leaves **uncommitted** changes. It must not run Git, `gh`, or GitLab API commands. The runners handle staging, secret checks, commit, push, PR/MR creation, and cleanup back to `main`.

**MR review runs:** Cursor inspects the MR branch/diff and writes a Markdown review to `.ai-mr-review.md`. The runner posts that text as a GitLab MR note, then discards the file and returns to `main`. Cursor must not change product code or call the GitLab API.

## Safety

- Clean repo required before start
- Blocks staging `.env`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- No auto-merge
- Single worker via file lock
- One issue per polling interval
- Local task branch deleted after push; remote branch kept for the PR/MR

## Directory layout

```
ai-worker/
├── worker.sh                 # Poll loop (GitHub + GitLab issues + GitLab MR reviews)
├── run-issue.sh              # GitHub issue pipeline
├── run-gitlab-issue.sh       # GitLab issue pipeline
├── run-gitlab-mr-review.sh   # GitLab MR AI review + comment
├── setup-labels.sh           # Labels on GitHub + GitLab
├── setup-gitlab-labels.sh    # GitLab labels only (issues + MR review)
├── ai-worker.service         # systemd unit (copy to /etc/systemd/system/)
├── projects.conf             # GitHub name → local path
├── gitlab-projects.conf      # GitLab name → local path
├── .env.example              # GITLAB_HOST / GITLAB_TOKEN template
├── lib/
│   ├── common.sh
│   └── gitlab.sh
├── logs/
└── state/
```

## Configuration

| Setting | Location | Default |
|---------|----------|---------|
| Poll interval | `worker.sh` → `CHECK_INTERVAL` | 60 seconds |
| Base directory | Scripts → `BASE_DIR` | `/home/ubuntu/ai-worker` |
| GitLab host | `.env` → `GITLAB_HOST` | `git.dctm.dev` |
| GitLab token | `.env` → `GITLAB_TOKEN` | required for GitLab |
| Branch naming | runners | `ai/issue-<number>` |

## Troubleshooting

| Problem | What to check |
|---------|----------------|
| Issue not picked up | Open? Has `ai`? Correct conf file? Service running? |
| MR review not picked up | MR open? Has `ai-review`? Labels created via `./setup-gitlab-labels.sh`? |
| GitLab skipped | `.env` has `GITLAB_TOKEN`? Restart service after editing `.env` |
| `ai-failed` | `logs/<project>-*-issue-<n>-*.log` and `*.cursor.ndjson` |
| `ai-review-failed` | `logs/<project>-gitlab-mr-<iid>-*.log` and `*.cursor.ndjson` |
| Worker not starting | `systemctl status ai-worker` or lock `state/worker.lock` |
| `agent: command not found` | PATH in the unit file must include `~/.local/bin` |
| PR/MR not created | `gh auth status` (GitHub) or token scopes / SSH push (GitLab) |
| Review comment missing | Token `api` scope; check runner log for note posting errors |

## License

Private infrastructure — adjust as needed for your organization.
