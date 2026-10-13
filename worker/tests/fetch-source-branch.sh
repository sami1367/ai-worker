#!/usr/bin/env bash
# Verify ai_fetch_and_checkout_source_branch works on --single-branch clones.
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

git clone --branch main --single-branch "file://$TMP/remote.git" "$TMP/work" >/dev/null 2>&1
git -C "$TMP/work" checkout -b ai/issue-9 >/dev/null
echo x >>"$TMP/work/f"
git -C "$TMP/work" add f
git -C "$TMP/work" -c commit.gpgsign=false commit -m fix >/dev/null
git -C "$TMP/work" push -u origin ai/issue-9 >/dev/null 2>&1
git -C "$TMP/work" checkout main >/dev/null
git -C "$TMP/work" branch -D ai/issue-9 >/dev/null

# Mimic review: only default-branch fetch refspec, no local task branch.
if git -C "$TMP/work" show-ref --verify --quiet "refs/remotes/origin/ai/issue-9"; then
    echo "FAIL: expected no origin/ai/issue-9 before helper (single-branch)"
    exit 1
fi

ai_fetch_and_checkout_source_branch "$TMP/work" "ai/issue-9"

current="$(git -C "$TMP/work" branch --show-current)"
[[ "$current" == "ai/issue-9" ]] || {
    echo "FAIL: expected checkout ai/issue-9, got $current"
    exit 1
}

git -C "$TMP/work" show-ref --verify --quiet "refs/remotes/origin/ai/issue-9" || {
    echo "FAIL: origin/ai/issue-9 missing after helper"
    exit 1
}

# Missing remote branch should return 13.
set +e
ai_fetch_and_checkout_source_branch "$TMP/work" "ai/issue-does-not-exist" >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -eq 13 ]] || {
    echo "FAIL: expected exit 13 for missing branch, got $rc"
    exit 1
}

echo "OK: fetch-source-branch"
