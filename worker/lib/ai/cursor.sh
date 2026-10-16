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
# --sandbox: OS-level sandbox for agent shell tools (defense in depth;
#            forge credentials are still stripped by ai_isolation_exec)
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

    # Default: enable Cursor's command sandbox. Operators may override with
    # AI_CURSOR_SANDBOX=disabled (not a substitute for ai_isolation_exec).
    # When user namespaces are blocked, Cursor's enabled sandbox fails the same
    # way Codex workspace-write does — disable it and keep ai_isolation_exec.
    local sandbox_mode="${AI_CURSOR_SANDBOX:-enabled}"
    case "$sandbox_mode" in
        enabled | disabled) ;;
        "")
            sandbox_mode=""
            ;;
        *)
            echo "WARNING: Ignoring invalid AI_CURSOR_SANDBOX='$sandbox_mode' (use enabled|disabled)." >&2
            sandbox_mode="enabled"
            ;;
    esac
    if [[ "$sandbox_mode" == "enabled" ]] && ! ai_isolation_userns_usable; then
        echo "WARNING: User namespaces unavailable; Cursor --sandbox enabled cannot run tools. Using disabled (OS isolation via ai_isolation_exec remains)." >&2
        sandbox_mode="disabled"
    fi
    if [[ -n "$sandbox_mode" ]]; then
        cmd+=(--sandbox "$sandbox_mode")
    fi

    if [[ -n "${AI_CURSOR_MODEL:-}" ]]; then
        cmd+=(--model "$AI_CURSOR_MODEL")
    fi

    if [[ -n "${AI_CURSOR_EXTRA_ARGS:-}" ]]; then
        # shellcheck disable=SC2206
        local extra=($AI_CURSOR_EXTRA_ARGS)
        cmd+=("${extra[@]}")
    fi

    cmd+=("$(cat "$prompt_file")")

    # Isolation wraps only the agent binary; tee stays in the trusted parent.
    ai_isolation_exec "$workspace" -- "${cmd[@]}" \
        2> >(tee -a "$stderr_log" >&2) \
        | tee -a "$stdout_log"

    return "${PIPESTATUS[0]}"
}
