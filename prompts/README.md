# AI prompt templates

Edit these files to change what the AI agent is told for each task. After changes, restart the worker:

```bash
sudo systemctl restart ai-worker
```

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
| `implement-process.txt` | Issue implementation steps |
| `implement-final-response.txt` | What to report after implementing |
| `implement-merge-notes.txt` | Write `.ai-*-notes.md` for the PR/MR comment (env, deploy, verify) |
| `minimal-changes.txt` | Only edit files/classes the issue requires; no extra diffs |
| `review-output-guidelines.txt` | Markdown structure for review comments |
| `review-scope.txt` | Review only the current PR/MR diff; no project-wide comments |

## Placeholders

Templates use `{{NAME}}` placeholders filled at runtime, for example:

- `{{ISSUE_TITLE}}`, `{{ISSUE_BODY}}`, `{{ISSUE_COMMENTS_TEXT}}`
- `{{PR_TITLE}}`, `{{LINKED_ISSUES}}`, `{{DIFF}}`
- `{{REVIEW_FILE}}` — path where the agent must write the review
- `{{NOTES_FILE}}` — path where the agent must write merge/PR notes (posted as a comment)

Rendered prompts are also saved to `logs/*.prompt.txt` for debugging.

## Syntax

- `{{INCLUDE:snippets/foo.txt}}` — insert another file (can be nested)
- `{{VARIABLE}}` — replaced with runtime value from the runner script

Do not remove required placeholders unless you also change the runner scripts in `run-*.sh`.
