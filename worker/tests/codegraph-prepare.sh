#!/usr/bin/env bash
# Verify ai_codegraph_prepare enable/disable behavior for .codegraph/
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "t@example.com"
  git -C "$dir" config user.name "t"
  echo ok >"$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -qm init
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

git_repo "$TMP/proj"

# Disabled: remove existing index, do not recreate.
mkdir -p "$TMP/proj/.codegraph"
echo '{}' >"$TMP/proj/.codegraph/meta.json"
out="$(ai_codegraph_prepare "$TMP/proj" 0 2>&1)"
[[ "$out" == *"***** CodeGraph: disabled"* ]] || fail "disabled log missing: $out"
[[ ! -d "$TMP/proj/.codegraph" ]] || fail "disabled should remove .codegraph"

# Enabled without CLI-dependent init when directory already present.
mkdir -p "$TMP/proj/.codegraph"
out="$(ai_codegraph_prepare "$TMP/proj" 1 2>&1)"
[[ "$out" == *"***** CodeGraph: enabled — index present"* ]] \
  || fail "enabled+present log missing: $out"
[[ -d "$TMP/proj/.codegraph" ]] || fail "enabled should keep .codegraph"

# Enabled + missing: either init succeeds or soft-fails if CLI absent — never hard-fail.
rm -rf "$TMP/proj/.codegraph"
out="$(ai_codegraph_prepare "$TMP/proj" 1 2>&1)" || fail "prepare should not exit non-zero"
[[ "$out" == *"***** CodeGraph:"* ]] || fail "enabled+missing should log: $out"

echo "OK: codegraph-prepare"
