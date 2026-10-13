# AI prompt templates (seed files)

These files are the **seed source** for the `prompt_templates` database table.

On web service startup, missing rows are inserted from this tree. After that, the
**database is the source of truth**. Edit prompts in the UI (**Prompts** page);
the worker fetches them from the DB before every job — **no worker restart**.

```text
worker/prompts/*.txt          → seed on startup (INSERT … ON CONFLICT DO NOTHING)
UI / Prompts panel            → edit content in Postgres
worker ai_prompt_render       → GET /api/v1/worker/internal/prompts each job
```

To restore a prompt to the seeded file content, use **Reset to seed** in the UI.

## Task templates

| File | Used when |
|------|-----------|
| `github-issue-implement.txt` | GitHub issue labeled `ai` |
| `gitlab-issue-implement.txt` | GitLab issue labeled `ai` |
| `github-pr-implement.txt` | GitHub PR labeled `ai` (update branch) |
| `gitlab-mr-implement.txt` | GitLab MR labeled `ai` (update branch) |
| `github-pr-review.txt` | GitHub PR labeled `ai-review` |
| `gitlab-mr-review.txt` | GitLab MR labeled `ai-review` |

## Shared snippets (`snippets/`)

Reusable blocks included via `{{INCLUDE:snippets/name.txt}}`:

| Snippet | Purpose |
|---------|---------|
| `comments-priority.txt` | Comments override title/description |
| `followup-review.txt` | Re-review after human replies; role handling |
| `decline-unrelated-task.txt` | Skip implementation; empty PR/MR with explanation |
| `implement-process.txt` | Issue implementation steps |
| `test-coverage.txt` | Tests must cover more than 80% of the lines this task changed |
| `implement-final-response.txt` | What to report after implementing |
| `implement-merge-notes.txt` | Write `.ai-*-notes.md` for the PR/MR comment (env, deploy, verify) |
| `minimal-changes.txt` | Required change only: no extra files, refactors, or improvements unless the issue asks |
| `related-services.txt` | From project docs, list other registered repos this change affects |
| `review-tests.txt` | On PR/MR review, read and run tests and report coverage of the change |
| `review-output-guidelines.txt` | Markdown structure for review comments |
| `review-scope.txt` | Review only the current PR/MR diff; no project-wide comments |

## Placeholders

Templates use `{{NAME}}` placeholders filled at runtime, for example:

- `{{ISSUE_TITLE}}`, `{{ISSUE_BODY}}`, `{{ISSUE_COMMENTS_TEXT}}`
- `{{PR_TITLE}}`, `{{LINKED_ISSUES}}`, `{{DIFF}}`
- `{{REVIEW_FILE}}` — path where the agent must write the review
- `{{NOTES_FILE}}` — path where the agent must write merge/PR notes (posted as a comment)
- `{{RELATED_TASKS_FILE}}` — JSON list of follow-up tasks for other registered repos
- `{{REGISTERED_PROJECTS}}` — names from `github-projects.conf` and `gitlab-projects.conf`
- `{{SOURCE_PROJECT}}` — conf name of the repository being changed

Rendered prompts are also saved to `logs/*.prompt.txt` for debugging.

## Syntax

- `{{INCLUDE:snippets/foo.txt}}` — insert another file (can be nested)
- `{{VARIABLE}}` — replaced with runtime value from the runner script

Do not remove required placeholders unless you also change the runner scripts in `run-*.sh`.

## Repository-specific prompts

Global templates/snippets apply to every repository. Each repository can also have
an optional **Repository prompt** (edited on the repository page). When non-empty,
the worker appends it to the rendered prompt as a final
`REPOSITORY-SPECIFIC INSTRUCTIONS` section. Default is empty.

## Fallback

If `WEB_INTERNAL_URL` / `WORKER_INTERNAL_TOKEN` are unset or the API fails, the
worker falls back to these seed files on disk.
