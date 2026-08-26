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
| `review-output-guidelines.txt` | Markdown structure for review comments |

## Placeholders

Templates use `{{NAME}}` placeholders filled at runtime, for example:

- `{{ISSUE_TITLE}}`, `{{ISSUE_BODY}}`, `{{ISSUE_COMMENTS_TEXT}}`
- `{{PR_TITLE}}`, `{{LINKED_ISSUES}}`, `{{DIFF}}`
- `{{REVIEW_FILE}}` — path where the agent must write the review

Rendered prompts are also saved to `logs/*.prompt.txt` for debugging.

## Syntax

- `{{INCLUDE:snippets/foo.txt}}` — insert another file (can be nested)
- `{{VARIABLE}}` — replaced with runtime value from the runner script

Do not remove required placeholders unless you also change the runner scripts in `run-*.sh`.
