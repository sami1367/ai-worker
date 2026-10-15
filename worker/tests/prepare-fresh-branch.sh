#!/usr/bin/env bash
# Verify ai_prepare_fresh_branch fetches a non-clone branch on --single-branch
# clones, hard-resets to origin, and discards dirty local state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -c init.defaultBranch=main init "$TMP/remote-src" >/dev/null
echo hi >"$TMP/remote-src/f"
git -C "$TMP/remote-src" add f
git -C "$TMP/remote-src" -c commit.gpgsign=false commit -m init >/dev/null
git clone --bare "$TMP/remote-src" "$TMP/remote.git" >/dev/null 2>&1

# Create a second remote branch that was not the clone target.
git clone "file://$TMP/remote.git" "$TMP/seed" >/dev/null 2>&1
git -C "$TMP/seed" checkout -b test >/dev/null
echo on-test >"$TMP/seed/f"
git -C "$TMP/seed" add f
git -C "$TMP/seed" -c commit.gpgsign=false commit -m 'test tip' >/dev/null
git -C "$TMP/seed" push -u origin test >/dev/null 2>&1

# Workspace cloned as --single-branch main only (like managed workspaces).
git clone --branch main --single-branch "file://$TMP/remote.git" "$TMP/work" >/dev/null 2>&1

# Local dirt that must be discarded.
echo dirty >"$TMP/work/f"
echo untracked >"$TMP/work/untracked.txt"
git -C "$TMP/work" checkout -b leftover-task >/dev/null

# origin/test must not exist yet under --single-branch.
if git -C "$TMP/work" show-ref --verify --quiet "refs/remotes/origin/test"; then
    echo "FAIL: expected no origin/test before prepare (single-branch)"
    exit 1
fi

ai_prepare_fresh_branch "$TMP/work" "test"

current="$(git -C "$TMP/work" branch --show-current)"
[[ "$current" == "test" ]] || {
    echo "FAIL: expected current branch test, got $current"
    exit 1
}

content="$(cat "$TMP/work/f")"
[[ "$content" == "on-test" ]] || {
    echo "FAIL: expected file content from origin/test, got: $content"
    exit 1
}

[[ ! -e "$TMP/work/untracked.txt" ]] || {
    echo "FAIL: untracked file should have been cleaned"
    exit 1
}

[[ -z "$(git -C "$TMP/work" status --porcelain)" ]] || {
    echo "FAIL: workspace should be clean after prepare"
    git -C "$TMP/work" status --short
    exit 1
}

# Local commits that diverge from origin must be wiped.
echo local-only >"$TMP/work/f"
git -C "$TMP/work" add f
git -C "$TMP/work" -c commit.gpgsign=false commit -m 'local diverge' >/dev/null

ai_prepare_fresh_branch "$TMP/work" "test"
content="$(cat "$TMP/work/f")"
[[ "$content" == "on-test" ]] || {
    echo "FAIL: hard reset should discard local commits, got: $content"
    exit 1
}

# Missing remote branch should return 13.
set +e
ai_prepare_fresh_branch "$TMP/work" "does-not-exist" >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -eq 13 ]] || {
    echo "FAIL: expected exit 13 for missing branch, got $rc"
    exit 1
}

echo "OK: prepare-fresh-branch"
