#!/usr/bin/env bash
# Exercises ai_extract_token_usage against Cursor / Claude / Codex stream-json samples.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=lib/ai.sh
source "$ROOT/lib/ai.sh"

CURSOR_LOG="$TMP/cursor.agent.ndjson"
CLAUDE_LOG="$TMP/claude.agent.ndjson"
CODEX_LOG="$TMP/codex.agent.ndjson"

cat > "$CURSOR_LOG" <<'EOF'
{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"inputTokens":5749,"outputTokens":25,"cacheReadTokens":9728,"cacheWriteTokens":0}}
EOF

cat > "$CLAUDE_LOG" <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet"}
{"type":"assistant","message":{"content":[]}}
{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.0042,"usage":{"input_tokens":1500,"output_tokens":420,"cache_read_input_tokens":800,"cache_creation_input_tokens":10}}
EOF

cat > "$CODEX_LOG" <<'EOF'
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"cache_write_input_tokens":12,"output_tokens":122,"reasoning_output_tokens":0}}
EOF

cursor_usage="$(ai_extract_token_usage "$CURSOR_LOG")"
claude_usage="$(ai_extract_token_usage "$CLAUDE_LOG")"
codex_usage="$(ai_extract_token_usage "$CODEX_LOG")"

echo "$cursor_usage" | jq -e '
  .inputTokens == 5749
  and .outputTokens == 25
  and .cacheReadTokens == 9728
  and .cacheWriteTokens == 0
  and .totalTokens == 5774
' >/dev/null

echo "$claude_usage" | jq -e '
  .inputTokens == 1500
  and .outputTokens == 420
  and .cacheReadTokens == 800
  and .cacheWriteTokens == 10
  and .totalTokens == 1920
  and .totalCostUsd == 0.0042
' >/dev/null

echo "$codex_usage" | jq -e '
  .inputTokens == 24763
  and .outputTokens == 122
  and .cacheReadTokens == 24448
  and .cacheWriteTokens == 12
  and .totalTokens == 24885
' >/dev/null

if ai_extract_token_usage "$TMP/missing.ndjson" 2>/dev/null; then
    echo "expected missing log to fail" >&2
    exit 1
fi

empty="$TMP/empty.agent.ndjson"
printf '%s\n' '{"type":"assistant","message":{}}' > "$empty"
if ai_extract_token_usage "$empty" 2>/dev/null; then
    echo "expected empty usage to fail" >&2
    exit 1
fi

echo "token-usage.sh: ok"
