#!/usr/bin/env bash
# Modular AI provider interface for ai-worker runners.
# Source after lib/common.sh (needs ai_log_banner) and ai_load_env.

# Code directory (this lib's parent). Runtime data may differ via BASE_DIR / AI_WORKER_BASE_DIR.
: "${WORKER_CODE_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ -z "${BASE_DIR:-}" ]]; then
  if [[ -n "${AI_WORKER_BASE_DIR:-}" ]]; then
    BASE_DIR="$AI_WORKER_BASE_DIR"
  else
    BASE_DIR="$WORKER_CODE_DIR"
  fi
fi

# Active provider id after ai_init (e.g. cursor, claude, codex, gemini).
AI_PROVIDER="${AI_PROVIDER:-cursor}"

# Set by ai_init / ai_run_agent:
AI_PROVIDER_BIN=""
AI_PROVIDER_NAME=""
AGENT_EXIT_CODE=0

AI_KNOWN_PROVIDERS=(cursor claude codex gemini)

# Technical agent↔forge isolation (env scrub + optional bubblewrap).
# shellcheck source=lib/ai-isolation.sh
source "$WORKER_CODE_DIR/lib/ai-isolation.sh"

ai_list_providers() {
    printf '%s\n' "${AI_KNOWN_PROVIDERS[@]}"
}

ai_init() {
    local provider="${AI_PROVIDER:-cursor}"
    local provider_file="$WORKER_CODE_DIR/lib/ai/${provider}.sh"

    if [[ ! -f "$provider_file" ]]; then
        echo "ERROR: Unknown AI provider: $provider" >&2
        echo "Supported providers: $(ai_list_providers | tr '\n' ' ')" >&2
        return 1
    fi

    # shellcheck source=lib/ai/cursor.sh
    # shellcheck source=lib/ai/claude.sh
    # shellcheck source=lib/ai/codex.sh
    # shellcheck source=lib/ai/gemini.sh
    source "$provider_file"

    if ! declare -F "ai_${provider}_detect" >/dev/null 2>&1; then
        echo "ERROR: Provider $provider is missing ai_${provider}_detect." >&2
        return 1
    fi

    if ! declare -F "ai_${provider}_run" >/dev/null 2>&1; then
        echo "ERROR: Provider $provider is missing ai_${provider}_run." >&2
        return 1
    fi

    AI_PROVIDER="$provider"
    AI_PROVIDER_BIN="$("ai_${provider}_detect")" || return 1
    AI_PROVIDER_NAME="$("ai_${provider}_name")"
    AGENT_EXIT_CODE=0
    return 0
}

# ai_run_agent <workspace> <prompt_file> <stdout_log> <stderr_log> [task_type]
# task_type: implement | review
ai_run_agent() {
    local workspace="$1"
    local prompt_file="$2"
    local stdout_log="$3"
    local stderr_log="$4"
    local task_type="${5:-implement}"

    if [[ -z "${AI_PROVIDER_BIN:-}" ]]; then
        echo "ERROR: AI provider not initialized. Call ai_init first." >&2
        AGENT_EXIT_CODE=1
        return 1
    fi

    if [[ ! -f "$prompt_file" ]]; then
        echo "ERROR: Prompt file not found: $prompt_file" >&2
        AGENT_EXIT_CODE=1
        return 1
    fi

    case "$task_type" in
        implement | review) ;;
        *)
            echo "ERROR: Unknown AI task type: $task_type (use implement or review)" >&2
            AGENT_EXIT_CODE=1
            return 1
            ;;
    esac

    set +e
    "ai_${AI_PROVIDER}_run" \
        "$workspace" "$prompt_file" "$stdout_log" "$stderr_log" "$task_type"
    AGENT_EXIT_CODE=$?
    set -e
    return "$AGENT_EXIT_CODE"
}

ai_log_agent_start() {
    local title="${1:-STARTING AI AGENT}"
    ai_log_phase "AGENT" "$title"
    echo "Provider:      ${AI_PROVIDER_NAME} (${AI_PROVIDER})"
    echo "Binary:        $AI_PROVIDER_BIN"
}

ai_log_agent_finish() {
    ai_log_banner "AI AGENT FINISHED"
    echo "Provider:  ${AI_PROVIDER_NAME} (${AI_PROVIDER})"
    echo "Exit code: ${AGENT_EXIT_CODE}"
    echo "Finished:  $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "============================================================"
}

# Parse token usage from Cursor / Claude / Codex / Gemini agent logs.
# Prints a single JSON object, or nothing (exit 1) when unavailable.
# Usage: ai_extract_token_usage <agent.ndjson>
ai_extract_token_usage() {
    local file="${1:-}"
    local result_line

    [[ -n "$file" && -f "$file" ]] || return 1
    command -v jq >/dev/null 2>&1 || return 1

    # Prefer the last terminal usage event:
    #   Cursor/Claude → type=result
    #   Codex exec --json → type=turn.completed
    result_line="$(
        jq -c 'select(
            type == "object"
            and (.type == "result" or .type == "turn.completed")
            and (.usage | type) == "object"
        )' "$file" 2>/dev/null \
            | tail -n 1
    )"
    if [[ -n "$result_line" ]]; then
        jq -c '
            . as $r
            | .usage
            | {
                inputTokens: ((.inputTokens // .input_tokens // 0) | tonumber? // 0 | floor),
                outputTokens: ((.outputTokens // .output_tokens // 0) | tonumber? // 0 | floor),
                cacheReadTokens: (
                    (.cacheReadTokens // .cache_read_input_tokens // .cache_read_tokens // .cached_input_tokens // 0)
                    | tonumber? // 0 | floor
                ),
                cacheWriteTokens: (
                    (.cacheWriteTokens // .cache_creation_input_tokens // .cache_write_tokens // .cache_write_input_tokens // 0)
                    | tonumber? // 0 | floor
                )
              }
            | . + { totalTokens: (.inputTokens + .outputTokens) }
            | if ($r.total_cost_usd // $r.totalCostUsd) != null then
                . + { totalCostUsd: ($r.total_cost_usd // $r.totalCostUsd) }
              else . end
        ' <<<"$result_line" 2>/dev/null
        return $?
    fi

    # Gemini CLI --output-format json (or a stream line with .stats.models):
    # aggregate prompt/candidates/cached across models.
    jq -nce '
        [inputs | select(type == "object" and (.stats.models | type) == "object")]
        | last // empty
        | .stats.models
        | to_entries
        | map(.value.tokens // {})
        | {
            inputTokens: (map(.prompt // 0) | add // 0 | tonumber? // 0 | floor),
            outputTokens: (map(.candidates // .response // 0) | add // 0 | tonumber? // 0 | floor),
            cacheReadTokens: (map(.cached // 0) | add // 0 | tonumber? // 0 | floor),
            cacheWriteTokens: 0
          }
        | . + { totalTokens: (.inputTokens + .outputTokens) }
    ' <"$file" 2>/dev/null
}
