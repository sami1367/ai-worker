#!/usr/bin/env bash
# OpenAI Codex CLI provider. Loaded by lib/ai.sh — do not source directly.

ai_codex_name() {
    printf '%s\n' "Codex"
}

ai_codex_detect() {
    local bin
    bin="$(command -v codex || true)"
    if [[ -z "$bin" ]]; then
        echo "ERROR: Codex CLI not found." >&2
        echo "Expected command: codex" >&2
        echo "See: https://developers.openai.com/codex/cli" >&2
        return 1
    fi
    printf '%s\n' "$bin"
}

# Headless automation settings live here:
#   codex exec           : non-interactive run (scripts / CI)
#   --sandbox            : workspace-write so the agent can edit files
#   --json               : JSONL events on stdout (token usage + progress)
#   --ephemeral          : do not persist a local session under CODEX_HOME
# Auth: CODEX_API_KEY (preferred for exec) and/or OPENAI_API_KEY from
# provider-credentials.env. Isolation still strips forge tokens.
ai_codex_run() {
    local workspace="$1"
    local prompt_file="$2"
    local stdout_log="$3"
    local stderr_log="$4"
    local task_type="${5:-implement}"

    local sandbox_mode="${AI_CODEX_SANDBOX:-workspace-write}"
    if [[ "$task_type" == "review" && -n "${AI_CODEX_REVIEW_SANDBOX:-}" ]]; then
        sandbox_mode="$AI_CODEX_REVIEW_SANDBOX"
    fi
    case "$sandbox_mode" in
        read-only | workspace-write | danger-full-access) ;;
        *)
            echo "WARNING: Ignoring invalid AI_CODEX_SANDBOX='$sandbox_mode' (use read-only|workspace-write|danger-full-access)." >&2
            sandbox_mode="workspace-write"
            ;;
    esac

    # Codex read-only / workspace-write sandboxes need user namespaces. When the
    # runtime blocks them (common under default Docker AppArmor/seccomp), Codex
    # reports "sandbox namespace error" and "Failed to write file". Rely on
    # ai_isolation_exec for the security boundary and open the Codex sandbox.
    if [[ "$sandbox_mode" != "danger-full-access" ]] && ! ai_isolation_userns_usable; then
        echo "WARNING: User namespaces unavailable; Codex sandbox '$sandbox_mode' cannot write files. Using danger-full-access (OS isolation via ai_isolation_exec remains)." >&2
        sandbox_mode="danger-full-access"
    fi

    local -a cmd=("$AI_PROVIDER_BIN" exec)
    cmd+=(--cd "$workspace")
    cmd+=(--sandbox "$sandbox_mode")
    cmd+=(--json)
    cmd+=(--ephemeral)

    if [[ -n "${AI_CODEX_MODEL:-}" ]]; then
        cmd+=(--model "$AI_CODEX_MODEL")
    fi

    if [[ -n "${AI_CODEX_EXTRA_ARGS:-}" ]]; then
        # shellcheck disable=SC2206
        local extra=($AI_CODEX_EXTRA_ARGS)
        cmd+=("${extra[@]}")
    fi

    cmd+=("$(cat "$prompt_file")")

    # Isolation wraps only the agent binary; tee stays in the trusted parent.
    # Prefer CODEX_API_KEY for non-interactive exec when only OPENAI_API_KEY is set.
    (
        if [[ -z "${CODEX_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]]; then
            export CODEX_API_KEY="$OPENAI_API_KEY"
        fi
        ai_isolation_exec "$workspace" -- "${cmd[@]}"
    ) \
        2> >(tee -a "$stderr_log" >&2) \
        | tee -a "$stdout_log"

    return "${PIPESTATUS[0]}"
}
