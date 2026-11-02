#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
source "$ROOT/lib/ai.sh"
AI_PROVIDER=stub
AI_PROVIDER_BIN=stub
printf 'test prompt' > "$TMP/prompt"
ai_stub_run() {
    false | cat
    return "${PIPESTATUS[0]}"
}
# Match the runner call: retain the failure for diagnostics without exiting.
ai_run_agent "$TMP" "$TMP/prompt" "$TMP/out" "$TMP/err" review || true
[[ "$AGENT_EXIT_CODE" -eq 1 ]]
[[ "$-" == *e* ]]
# Also preserve callers which intentionally disable errexit (cleanup handlers).
set +e
ai_run_agent "$TMP" "$TMP/prompt" "$TMP/out" "$TMP/err" review
rc=$?
[[ "$-" != *e* ]] || exit 1
set -e
[[ "$rc" -eq 1 ]]
ai_stub_run() { return 0; }
ai_run_agent "$TMP" "$TMP/prompt" "$TMP/out" "$TMP/err" review
[[ "$AGENT_EXIT_CODE" -eq 0 ]]

# Exercise a real job's error path with a failed runner, without forge access.
sed -n '/^gitlab_mr_review_job() {$/,/^}$/p' "$ROOT/worker.sh" > "$TMP/job.sh"
source "$TMP/job.sh"
ai_log_banner() { :; }
ai_try_claim_repo_lock() { return 0; }
ai_ensure_project_labels() { :; }
gitlab_edit_mr_labels() { printf '%s\n' "$*" >> "$TMP/labels"; }
ai_post_gitlab_failure_comment() { printf 'failure\n' > "$TMP/comment"; }
WORKER_CODE_DIR="$TMP"
LOG_DIR="$TMP"
printf '#!/usr/bin/env bash\nexit 42\n' > "$TMP/run-gitlab-mr-review.sh"
chmod +x "$TMP/run-gitlab-mr-review.sh"
# Run in a separate shell: jobs deliberately toggle errexit internally.
set +e
( gitlab_mr_review_job demo group/demo 14 ) > "$TMP/job.log"
rc=$?
set -e
[[ "$rc" -eq 42 ]]
[[ -s "$TMP/comment" ]]
rg -q -- '--add ai-review-failed --remove ai-reviewing' "$TMP/labels"
# A later successful task can still run.
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/run-gitlab-mr-review.sh"
( gitlab_mr_review_job demo group/demo 15 ) > "$TMP/next.log"
echo 'PASS: provider errors preserve shell options, task failure status, and subsequent tasks'
