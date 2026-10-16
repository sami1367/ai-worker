#!/usr/bin/env bash
# GitHub Copilot CLI provider. Loaded by lib/ai.sh — do not source directly.

ai_copilot_name() {
    printf '%s\n' "GitHub Copilot"
}

ai_copilot_detect() {
    local bin
    bin="$(command -v copilot || true)"
    if [[ -z "$bin" ]]; then
        echo "ERROR: GitHub Copilot CLI not found." >&2
        echo "Expected command: copilot" >&2
        echo "See: https://docs.github.com/en/copilot/get-started/cli-quickstart" >&2
        return 1
    fi
    printf '%s\n' "$bin"
}

# Headless automation settings live here:
#   -p / --prompt     : non-interactive run (scripts / CI)
#   --yolo            : allow-all tools/paths/urls (implement default)
#   --no-ask-user     : autonomous (disable ask_user prompts)
#   --output-format   : json for JSONL logs
# Auth: COPILOT_GITHUB_TOKEN from provider-credentials.env (fine-grained PAT
# with "Copilot Requests"). Do not use GH_TOKEN/GITHUB_TOKEN — agent isolation
# strips those forge credentials.
ai_copilot_run() {
    local workspace="$1"
    local prompt_file="$2"
    local stdout_log="$3"
    local stderr_log="$4"
    local task_type="${5:-implement}"

    local output_format="${AI_COPILOT_OUTPUT_FORMAT:-json}"
    local permission_mode="${AI_COPILOT_PERMISSION_MODE:-}"
    if [[ "$task_type" == "review" && -n "${AI_COPILOT_REVIEW_PERMISSION_MODE:-}" ]]; then
        permission_mode="$AI_COPILOT_REVIEW_PERMISSION_MODE"
    fi

    local -a cmd=("$AI_PROVIDER_BIN")
    cmd+=(-p "$(cat "$prompt_file")")
    cmd+=(--no-ask-user)
    cmd+=(--output-format "$output_format")

    if [[ -n "$permission_mode" ]]; then
        case "$permission_mode" in
            yolo | allow-all)
                cmd+=(--yolo)
                ;;
            allow-all-tools)
                cmd+=(--allow-all-tools)
                ;;
            default)
                ;;
            *)
                echo "WARNING: Ignoring invalid AI_COPILOT_PERMISSION_MODE='$permission_mode' (use yolo|allow-all|allow-all-tools|default)." >&2
                cmd+=(--yolo)
                ;;
        esac
    else
        # Default: YOLO so headless implement/review can edit without prompts.
        cmd+=(--yolo)
    fi

    # Copilot command sandboxing is off unless --sandbox or sandbox.enabled.
    # We never pass --sandbox: on Linux it is another bubblewrap namespace.
    if ai_provider_nested_sandbox_blocked; then
        echo "WARNING: Copilot nested sandbox left disabled (OS isolation via ai_isolation_exec remains)." >&2
    fi

    if [[ -n "${AI_COPILOT_MODEL:-}" ]]; then
        cmd+=(--model "$AI_COPILOT_MODEL")
    fi

    if [[ -n "${AI_COPILOT_EXTRA_ARGS:-}" ]]; then
        # shellcheck disable=SC2206
        local extra=($AI_COPILOT_EXTRA_ARGS)
        cmd+=("${extra[@]}")
    fi

    # Isolation wraps only the agent binary; tee stays in the trusted parent.
    (
        cd "$workspace" || exit 1
        ai_isolation_exec "$workspace" -- "${cmd[@]}"
    ) \
        2> >(tee -a "$stderr_log" >&2) \
        | tee -a "$stdout_log"

    return "${PIPESTATUS[0]}"
}
