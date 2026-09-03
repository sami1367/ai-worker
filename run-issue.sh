#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT="${1:-}"
ISSUE_NUMBER="${2:-}"

BASE_DIR="/home/ubuntu/ai-worker"
PROJECTS_FILE="$BASE_DIR/projects.conf"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$BASE_DIR/logs"

# shellcheck source=lib/common.sh
source "$BASE_DIR/lib/common.sh"
# shellcheck source=lib/prompts.sh
source "$BASE_DIR/lib/prompts.sh"
# shellcheck source=lib/ai.sh
source "$BASE_DIR/lib/ai.sh"

mkdir -p "$STATE_DIR" "$LOG_DIR"
ai_load_env "$BASE_DIR/.env"

# ============================================================
# Validate input
# ============================================================

if [[ -z "$PROJECT" || -z "$ISSUE_NUMBER" ]]; then
    echo "Usage: $0 <project> <issue-number>"
    exit 1
fi

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: issue number must be numeric."
    exit 1
fi

if [[ ! -f "$PROJECTS_FILE" ]]; then
    echo "ERROR: Projects file not found: $PROJECTS_FILE"
    exit 1
fi

# ============================================================
# Required commands
# ============================================================

ai_require_cmds git gh jq tee || exit 1

# AI provider is initialized later — skipped for title "new release".

# ============================================================
# Resolve project
# ============================================================

PROJECT_DIR="$(
    awk -F= -v project="$PROJECT" '
        /^[[:space:]]*#/ { next }

        NF >= 2 && $1 == project {
            sub(/^[^=]*=/, "")
            print
            exit
        }
    ' "$PROJECTS_FILE"
)"

if [[ -z "$PROJECT_DIR" ]]; then
    echo "ERROR: Project is not registered: $PROJECT"
    exit 1
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "ERROR: Project directory does not exist:"
    echo "$PROJECT_DIR"
    exit 1
fi

if ! git -C "$PROJECT_DIR" rev-parse \
    --is-inside-work-tree >/dev/null 2>&1; then

    echo "ERROR: Not a Git repository:"
    echo "$PROJECT_DIR"
    exit 1
fi

# ============================================================
# Log files
# ============================================================

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

LOG_FILE="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.log"

AGENT_LOG="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.agent.ndjson"
AGENT_ERR_LOG="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.agent.stderr.log"

PROMPT_FILE="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.prompt.txt"

RESULT_FILE="$LOG_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}.result.txt"

STATE_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}.running"

# Everything printed by this script also goes into the main log.
exec > >(tee -a "$LOG_FILE") 2>&1

BRANCH=""
REPO=""
ISSUE_TITLE=""
ISSUE_URL=""
PR_URL=""

# ============================================================
# Cleanup
#
# This ALWAYS attempts to put the repository back on main.
# ============================================================

cleanup() {
    rc=$?

    trap - EXIT INT TERM
    set +e

    echo
    echo "============================================================"
    echo "                     CLEANUP"
    echo "============================================================"
    echo "Exit code: $rc"

    if git -C "$PROJECT_DIR" rev-parse \
        --is-inside-work-tree >/dev/null 2>&1; then

        current_branch="$(
            git -C "$PROJECT_DIR" branch --show-current \
                2>/dev/null || true
        )"

        if [[ "$current_branch" != "main" ]]; then

            if [[ -n "$(
                git -C "$PROJECT_DIR" status --porcelain \
                    2>/dev/null
            )" ]]; then

                echo "Discarding remaining task changes"
                echo "before returning to main..."

                echo
                echo "Changed files before cleanup:"

                git -C "$PROJECT_DIR" status --short || true

                git -C "$PROJECT_DIR" reset --hard HEAD || true

                # Removes untracked files created by the task.
                # Ignored files such as node_modules/vendor remain.
                git -C "$PROJECT_DIR" clean -fd || true
            fi

            echo
            echo "Checking out main..."

            git -C "$PROJECT_DIR" checkout main || true
        fi

        # Remove local AI branch after returning to main.
        #
        # The successful branch still exists on GitHub because it
        # was already pushed before the PR was created.
        if [[ -n "$BRANCH" ]] &&
           git -C "$PROJECT_DIR" show-ref \
               --verify --quiet "refs/heads/$BRANCH"; then

            if [[ "$(
                git -C "$PROJECT_DIR" branch --show-current \
                    2>/dev/null || true
            )" != "$BRANCH" ]]; then

                echo "Deleting local task branch:"
                echo "$BRANCH"

                git -C "$PROJECT_DIR" branch -D "$BRANCH" || true
            fi
        fi
    fi

    rm -f "$STATE_FILE"

    echo
    echo "Current branch: $(
        git -C "$PROJECT_DIR" branch --show-current \
            2>/dev/null || echo unknown
    )"

    echo "Finished: $(date '+%Y-%m-%d %H:%M:%S %Z')"

    echo "============================================================"

    exit "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ============================================================
# State file
# ============================================================

cat > "$STATE_FILE" <<EOF
project=$PROJECT
issue=$ISSUE_NUMBER
started=$(date '+%Y-%m-%d %H:%M:%S %Z')
pid=$$
log=$LOG_FILE
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

# ============================================================
# Start information
# ============================================================

ai_log_banner "AI GITHUB ISSUE WORKER"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Project:       $PROJECT"
echo "Issue:         #$ISSUE_NUMBER"
echo "Project dir:   $PROJECT_DIR"
echo "Main log:      $LOG_FILE"
echo "============================================================"

# ============================================================
# Repository must start clean
# ============================================================

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then

    echo
    echo "ERROR:"
    echo "Repository has uncommitted/untracked changes"
    echo "before starting."

    git -C "$PROJECT_DIR" status --short

    exit 10
fi

# ============================================================
# Determine GitHub repository
# ============================================================

REPO="$(
    cd "$PROJECT_DIR"

    gh repo view \
        --json nameWithOwner \
        --jq '.nameWithOwner'
)"

if [[ -z "$REPO" ]]; then
    echo "ERROR: Could not determine GitHub repository."
    exit 11
fi

echo
echo "Repository: $REPO"
echo "Origin: $(git -C "$PROJECT_DIR" remote get-url origin)"

# ============================================================
# Update main
# ============================================================

echo
echo "Fetching origin..."

git -C "$PROJECT_DIR" fetch --prune origin

echo
echo "Checking out main..."

git -C "$PROJECT_DIR" checkout main

echo
echo "Updating main with fast-forward only..."

git -C "$PROJECT_DIR" pull --ff-only origin main

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then

    echo
    echo "ERROR: main is not clean after update."

    git -C "$PROJECT_DIR" status --short

    exit 12
fi

# ============================================================
# Read GitHub issue
# ============================================================

echo
echo "Reading GitHub issue #$ISSUE_NUMBER..."

ISSUE_JSON="$(
    gh issue view "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --json number,title,body,labels,state,url
)"

ISSUE_TITLE="$(
    jq -r '.title' <<<"$ISSUE_JSON"
)"

ISSUE_BODY="$(
    jq -r '.body // ""' <<<"$ISSUE_JSON"
)"

ISSUE_URL="$(
    jq -r '.url' <<<"$ISSUE_JSON"
)"

ISSUE_STATE="$(
    jq -r '.state' <<<"$ISSUE_JSON"
)"

echo
echo "Title: $ISSUE_TITLE"
echo "State: $ISSUE_STATE"
echo "URL:   $ISSUE_URL"

if [[ "$ISSUE_STATE" != "OPEN" ]]; then

    echo
    echo "Issue is not open."
    echo "Nothing to do."

    exit 0
fi

# ============================================================
# Special case: title "new release" or "new tag"
#
# Skip the AI agent. Fetch tags, bump the latest vMAJOR.MINOR.PATCH
# tag by one on the patch component, and create a draft GitHub release.
# ============================================================

ISSUE_TITLE_NORM="$(
    printf '%s' "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
)"

if [[ "$ISSUE_TITLE_NORM" == "new release" || "$ISSUE_TITLE_NORM" == "new tag" ]]; then

    ai_log_banner "NEW RELEASE / NEW TAG (NO AI)"
    echo "Issue title matches '$ISSUE_TITLE_NORM'."
    echo "Skipping AI agent; creating the next draft GitHub release."
    echo "============================================================"

    echo
    echo "Fetching all tags from origin..."

    git -C "$PROJECT_DIR" fetch --tags --prune origin

    LATEST_TAG="$(
        git -C "$PROJECT_DIR" tag -l 'v*.*.*' --sort=-v:refname |
            head -n 1
    )"

    if [[ -z "$LATEST_TAG" ]]; then
        echo
        echo "ERROR: No tags matching vMAJOR.MINOR.PATCH were found."
        echo "Create an initial tag (for example v0.0.1) before using 'new release'."
        exit 50
    fi

    if [[ ! "$LATEST_TAG" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        echo
        echo "ERROR: Latest tag is not in vMAJOR.MINOR.PATCH format: $LATEST_TAG"
        exit 51
    fi

    TAG_MAJOR="${BASH_REMATCH[1]}"
    TAG_MINOR="${BASH_REMATCH[2]}"
    TAG_PATCH="${BASH_REMATCH[3]}"
    NEW_PATCH=$((TAG_PATCH + 1))
    NEW_TAG="v${TAG_MAJOR}.${TAG_MINOR}.${NEW_PATCH}"

    echo
    echo "Latest tag:  $LATEST_TAG"
    echo "New tag:     $NEW_TAG"

    if git -C "$PROJECT_DIR" rev-parse -q --verify "refs/tags/${NEW_TAG}" >/dev/null; then
        echo
        echo "ERROR: Tag already exists locally: $NEW_TAG"
        exit 52
    fi

    if gh release view "$NEW_TAG" --repo "$REPO" >/dev/null 2>&1; then
        echo
        echo "ERROR: A GitHub release already exists for: $NEW_TAG"
        exit 53
    fi

    echo
    echo "Creating draft release: $NEW_TAG"
    echo "Command: gh release create $NEW_TAG --repo $REPO --draft --generate-notes"

    RELEASE_URL="$(
        gh release create "$NEW_TAG" \
            --repo "$REPO" \
            --draft \
            --generate-notes
    )"

    if [[ -z "$RELEASE_URL" ]]; then
        echo
        echo "ERROR: gh release create did not return a release URL."
        exit 54
    fi

    echo
    echo "Draft release created:"
    echo "$RELEASE_URL"

    COMMENT_BODY="$(cat <<EOF
## Automated draft release

Skipped the AI agent because this issue title is \`$ISSUE_TITLE_NORM\`.

- Previous tag: \`$LATEST_TAG\`
- New draft release: \`$NEW_TAG\`
- URL: $RELEASE_URL

Publish the draft on GitHub when you are ready. This automation never publishes releases automatically.
EOF
)"

    echo
    echo "Commenting on issue #$ISSUE_NUMBER..."
    gh issue comment "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --body "$COMMENT_BODY"

    echo
    echo "Closing issue #$ISSUE_NUMBER..."
    gh issue close "$ISSUE_NUMBER" \
        --repo "$REPO" \
        --comment "Closed after creating draft release $NEW_TAG."

    cat > "$RESULT_FILE" <<EOF
project=$PROJECT
repository=$REPO
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
mode=new-release
previous_tag=$LATEST_TAG
new_tag=$NEW_TAG
release_url=$RELEASE_URL
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
EOF

    ai_log_banner "RELEASE COMPLETE"
    echo "Project:      $PROJECT"
    echo "Issue:        #$ISSUE_NUMBER"
    echo "Previous tag: $LATEST_TAG"
    echo "New tag:      $NEW_TAG"
    echo "Release:      $RELEASE_URL"
    echo "Main log:     $LOG_FILE"
    echo "Result file:  $RESULT_FILE"
    echo "============================================================"

    exit 0
fi

# ============================================================
# Initialize AI provider (normal issue path)
# ============================================================

ai_init || exit 1

cat >> "$STATE_FILE" <<EOF
ai_provider=$AI_PROVIDER
EOF

echo
echo "AI provider:   $AI_PROVIDER_NAME ($AI_PROVIDER)"
echo "AI binary:     $AI_PROVIDER_BIN"
echo "Agent log:     $AGENT_LOG"
echo "Agent stderr:  $AGENT_ERR_LOG"

# ============================================================
# Read issue comments
# ============================================================

echo
echo "Fetching issue comments..."

ISSUE_COMMENTS_JSON="$(ai_github_fetch_issue_comments "$REPO" "$ISSUE_NUMBER")"
ISSUE_COMMENTS_COUNT="$(jq 'length' <<<"$ISSUE_COMMENTS_JSON")"
ISSUE_COMMENTS_TEXT="$(ai_format_github_comments "$ISSUE_COMMENTS_JSON")"

echo "Comments: $ISSUE_COMMENTS_COUNT"

# ============================================================
# Create branch
# ============================================================

BASE_BRANCH="ai/issue-${ISSUE_NUMBER}"
BRANCH="$BASE_BRANCH"

# If the branch already exists locally or remotely,
# create a timestamped branch instead.
if git -C "$PROJECT_DIR" show-ref \
       --verify --quiet "refs/heads/$BRANCH" ||
   git -C "$PROJECT_DIR" show-ref \
       --verify --quiet "refs/remotes/origin/$BRANCH"; then

    BRANCH="${BASE_BRANCH}-${TIMESTAMP}"
fi

echo
echo "Creating task branch:"
echo "$BRANCH"

git -C "$PROJECT_DIR" checkout -b "$BRANCH" main

# ============================================================
# Build AI prompt
# ============================================================

ai_prompt_clear
ai_prompt_set REPO "$REPO"
ai_prompt_set PROJECT_DIR "$PROJECT_DIR"
ai_prompt_set ISSUE_NUMBER "$ISSUE_NUMBER"
ai_prompt_set ISSUE_URL "$ISSUE_URL"
ai_prompt_set ISSUE_TITLE "$ISSUE_TITLE"
ai_prompt_set ISSUE_BODY "$ISSUE_BODY"
ai_prompt_set ISSUE_COMMENTS_TEXT "$ISSUE_COMMENTS_TEXT"

ai_prompt_render "github-issue-implement.txt" "$PROMPT_FILE"

# ============================================================
# Run AI agent
# ============================================================

ai_log_agent_start "STARTING AI AGENT"
echo "Branch:        $BRANCH"
echo "Workspace:     $PROJECT_DIR"
echo "Prompt file:   $PROMPT_FILE"
echo "Agent log:     $AGENT_LOG"
echo "Agent stderr:  $AGENT_ERR_LOG"
echo "Started:       $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"

ai_run_agent "$PROJECT_DIR" "$PROMPT_FILE" "$AGENT_LOG" "$AGENT_ERR_LOG" implement

ai_log_agent_finish

if [[ "$AGENT_EXIT_CODE" -ne 0 ]]; then

    echo
    echo "ERROR: AI agent failed."

    exit "$AGENT_EXIT_CODE"
fi

# ============================================================
# Verify agent changed something
# ============================================================

echo
echo "Git status after AI agent:"

git -C "$PROJECT_DIR" status --short

if [[ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then

    echo
    echo "ERROR:"
    echo "Cursor completed but made no changes."

    exit 20
fi

# ============================================================
# Stage changes
# ============================================================

echo
echo "Staging changes..."

git -C "$PROJECT_DIR" add -A

CHANGED_FILES="$(
    git -C "$PROJECT_DIR" diff \
        --cached \
        --name-only
)"

echo
echo "Files to commit:"

printf '%s\n' "$CHANGED_FILES"

# ============================================================
# Basic secret/private-key protection
# ============================================================

if ai_has_secret_files "$CHANGED_FILES"; then
    echo
    echo "ERROR: A potential secret/private-key file is staged."
    echo "Refusing to continue."
    exit 30
fi

if git -C "$PROJECT_DIR" diff --cached --quiet; then

    echo
    echo "ERROR: Nothing staged after Cursor changes."

    exit 21
fi

# ============================================================
# Commit
# ============================================================

echo
echo "Creating commit..."

git -C "$PROJECT_DIR" commit \
    -m "fix: resolve issue #${ISSUE_NUMBER}"

COMMIT_SHA="$(
    git -C "$PROJECT_DIR" rev-parse HEAD
)"

echo
echo "Commit:"
echo "$COMMIT_SHA"

# ============================================================
# Push
# ============================================================

echo
echo "Pushing branch..."

git -C "$PROJECT_DIR" push \
    -u origin "$BRANCH"

# ============================================================
# Create PR body
# ============================================================

PR_BODY_FILE="$STATE_DIR/${PROJECT}-issue-${ISSUE_NUMBER}-${TIMESTAMP}-pr.md"

cat > "$PR_BODY_FILE" <<EOF
## Automated implementation

This pull request was created automatically by the server-side Cursor issue worker.

**Issue:** $ISSUE_URL

**Branch:** \`$BRANCH\`

**Commit:** \`$COMMIT_SHA\`

Closes #$ISSUE_NUMBER

### Review note

Please review the implementation and CI results before merging.

The automation never merges pull requests automatically.
EOF

# ============================================================
# Create Pull Request
# ============================================================

echo
echo "Creating pull request..."

gh pr create \
    --repo "$REPO" \
    --base main \
    --head "$BRANCH" \
    --title "Fix #${ISSUE_NUMBER}: ${ISSUE_TITLE}" \
    --body-file "$PR_BODY_FILE"

# Verify PR actually exists.
PR_URL="$(
    gh pr view "$BRANCH" \
        --repo "$REPO" \
        --json url \
        --jq '.url'
)"

if [[ -z "$PR_URL" ]]; then

    echo
    echo "ERROR:"
    echo "Pull request creation could not be verified."

    exit 40
fi

# ============================================================
# Save result
# ============================================================

cat > "$RESULT_FILE" <<EOF
project=$PROJECT
repository=$REPO
issue=$ISSUE_NUMBER
issue_url=$ISSUE_URL
branch=$BRANCH
commit=$COMMIT_SHA
pull_request=$PR_URL
completed=$(date '+%Y-%m-%d %H:%M:%S %Z')
main_log=$LOG_FILE
ai_provider=$AI_PROVIDER
agent_log=$AGENT_LOG
agent_stderr=$AGENT_ERR_LOG
EOF

ai_log_banner "ISSUE COMPLETE"
echo "Project:      $PROJECT"
echo "Issue:        #$ISSUE_NUMBER"
echo "Branch:       $BRANCH"
echo "Commit:       $COMMIT_SHA"
echo "Pull request: $PR_URL"
echo "Main log:     $LOG_FILE"
echo "Agent log:    $AGENT_LOG"
echo "Result file:  $RESULT_FILE"
echo "============================================================"
