#!/usr/bin/env bash
# Modular AI provider interface for ai-worker runners.
# Source after lib/common.sh (needs ai_log_banner) and ai_load_env.

: "${BASE_DIR:=/home/ubuntu/ai-worker}"

# Active provider id after ai_init (e.g. cursor, claude).
AI_PROVIDER="${AI_PROVIDER:-cursor}"

# Set by ai_init / ai_run_agent:
AI_PROVIDER_BIN=""
AI_PROVIDER_NAME=""
AGENT_EXIT_CODE=0

AI_KNOWN_PROVIDERS=(cursor claude)

ai_list_providers() {
    printf '%s\n' "${AI_KNOWN_PROVIDERS[@]}"
}

ai_init() {
    local provider="${AI_PROVIDER:-cursor}"
    local provider_file="$BASE_DIR/lib/ai/${provider}.sh"

    if [[ ! -f "$provider_file" ]]; then
        echo "ERROR: Unknown AI provider: $provider" >&2
        echo "Supported providers: $(ai_list_providers | tr '\n' ' ')" >&2
        return 1
    fi

    # shellcheck source=lib/ai/cursor.sh
    # shellcheck source=lib/ai/claude.sh
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
    ai_log_banner "$title"
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
