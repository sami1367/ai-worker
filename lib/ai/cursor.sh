#!/usr/bin/env bash
# Cursor CLI provider. Loaded by lib/ai.sh — do not source directly.

ai_cursor_name() {
    printf '%s\n' "Cursor"
}

ai_cursor_detect() {
    local bin
    bin="$(command -v agent || command -v cursor-agent || true)"
    if [[ -z "$bin" ]]; then
        echo "ERROR: Cursor CLI not found." >&2
        echo "Expected command: agent or cursor-agent" >&2
        return 1
    fi
    printf '%s\n' "$bin"
}

# Non-interactive Cursor flags live here so runners stay provider-agnostic.
# --force  : run without interactive confirmations
# --trust  : trust the workspace without prompting
ai_cursor_run() {
    local workspace="$1"
    local prompt_file="$2"
    local stdout_log="$3"
    local stderr_log="$4"
    local _task_type="${5:-implement}"

    local -a cmd=("$AI_PROVIDER_BIN")

    cmd+=(--workspace "$workspace")
    cmd+=(--force --trust --print)
    cmd+=(--output-format stream-json --stream-partial-output)

    if [[ -n "${AI_CURSOR_MODEL:-}" ]]; then
        cmd+=(--model "$AI_CURSOR_MODEL")
    fi

    if [[ -n "${AI_CURSOR_EXTRA_ARGS:-}" ]]; then
        # shellcheck disable=SC2206
        local extra=($AI_CURSOR_EXTRA_ARGS)
        cmd+=("${extra[@]}")
    fi

    cmd+=("$(cat "$prompt_file")")

    "${cmd[@]}" \
        2> >(tee -a "$stderr_log" >&2) \
        | tee -a "$stdout_log"

    return "${PIPESTATUS[0]}"
}
