#!/usr/bin/env bash
# Google Gemini CLI provider. Loaded by lib/ai.sh — do not source directly.

ai_gemini_name() {
    printf '%s\n' "Gemini"
}

ai_gemini_detect() {
    local bin
    bin="$(command -v gemini || true)"
    if [[ -z "$bin" ]]; then
        echo "ERROR: Gemini CLI not found." >&2
        echo "Expected command: gemini" >&2
        echo "See: https://github.com/google-gemini/gemini-cli" >&2
        return 1
    fi
    printf '%s\n' "$bin"
}

# Headless automation settings live here:
#   -p / --prompt     : non-interactive run (scripts / CI)
#   --yolo            : auto-approve tool actions (implement default)
#   --approval-mode   : optional override (default|auto_edit|yolo)
#   --output-format   : stream-json for NDJSON logs / usage parsing
# Auth: GEMINI_API_KEY from provider-credentials.env.
# Isolation still strips forge tokens.
ai_gemini_run() {
    local workspace="$1"
    local prompt_file="$2"
    local stdout_log="$3"
    local stderr_log="$4"
    local task_type="${5:-implement}"

    local output_format="${AI_GEMINI_OUTPUT_FORMAT:-stream-json}"
    local approval_mode="${AI_GEMINI_APPROVAL_MODE:-}"
    if [[ "$task_type" == "review" && -n "${AI_GEMINI_REVIEW_APPROVAL_MODE:-}" ]]; then
        approval_mode="$AI_GEMINI_REVIEW_APPROVAL_MODE"
    fi

    local -a cmd=("$AI_PROVIDER_BIN")
    cmd+=(-p)

    if [[ -n "$approval_mode" ]]; then
        case "$approval_mode" in
            default | auto_edit | yolo)
                cmd+=(--approval-mode "$approval_mode")
                ;;
            *)
                echo "WARNING: Ignoring invalid AI_GEMINI_APPROVAL_MODE='$approval_mode' (use default|auto_edit|yolo)." >&2
                cmd+=(--yolo)
                ;;
        esac
    else
        # Default: YOLO so headless implement/review can edit without prompts.
        cmd+=(--yolo)
    fi

    # Gemini --sandbox / GEMINI_SANDBOX starts docker, podman, or seatbelt.
    # Never enable that inside our isolation wrapper.
    if ai_provider_nested_sandbox_blocked; then
        echo "WARNING: Gemini nested sandbox unavailable; not using --sandbox (OS isolation via ai_isolation_exec remains)." >&2
        unset GEMINI_SANDBOX
    fi

    cmd+=(--output-format "$output_format")

    if [[ -n "${AI_GEMINI_MODEL:-}" ]]; then
        cmd+=(--model "$AI_GEMINI_MODEL")
    fi

    if [[ -n "${AI_GEMINI_EXTRA_ARGS:-}" ]]; then
        # shellcheck disable=SC2206
        local extra=($AI_GEMINI_EXTRA_ARGS)
        cmd+=("${extra[@]}")
    fi

    cmd+=("$(cat "$prompt_file")")

    # Isolation wraps only the agent binary; tee stays in the trusted parent.
    (
        cd "$workspace" || exit 1
        ai_isolation_exec "$workspace" -- "${cmd[@]}"
    ) \
        2> >(tee -a "$stderr_log" >&2) \
        | tee -a "$stdout_log"

    return "${PIPESTATUS[0]}"
}
