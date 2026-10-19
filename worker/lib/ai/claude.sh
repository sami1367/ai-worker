#!/usr/bin/env bash
# Claude Code CLI provider. Loaded by lib/ai.sh — do not source directly.

ai_claude_name() {
    printf '%s\n' "Claude Code"
}

ai_claude_detect() {
    local bin
    bin="$(command -v claude || true)"
    if [[ -z "$bin" ]]; then
        echo "ERROR: Claude Code CLI not found." >&2
        echo "Expected command: claude" >&2
        echo "See: https://code.claude.com/docs/en/setup" >&2
        return 1
    fi
    printf '%s\n' "$bin"
}

# Headless automation settings live here:
# --bare              : skip local hooks/skills/MCP for reproducible CI runs
# --permission-mode   : auto-approve edits without interactive prompts
# --verbose           : required by Claude Code when -p + --output-format=stream-json
# Tool allowlists are defense in depth; ai_isolation_exec is the security boundary.
ai_claude_run() {
    local workspace="$1"
    local prompt_file="$2"
    local stdout_log="$3"
    local stderr_log="$4"
    local task_type="${5:-implement}"

    local permission_mode="${AI_CLAUDE_PERMISSION_MODE:-acceptEdits}"
    if [[ "$task_type" == "review" && -n "${AI_CLAUDE_REVIEW_PERMISSION_MODE:-}" ]]; then
        permission_mode="$AI_CLAUDE_REVIEW_PERMISSION_MODE"
    fi

    local output_format="${AI_CLAUDE_OUTPUT_FORMAT:-stream-json}"

    local -a cmd=("$AI_PROVIDER_BIN")
    cmd+=(--bare -p)
    cmd+=(--permission-mode "$permission_mode")
    cmd+=(--output-format "$output_format")
    # Claude Code: --print + stream-json requires --verbose (else exits 1).
    if [[ "$output_format" == "stream-json" ]]; then
        cmd+=(--verbose)
    fi

    if [[ -n "${AI_CLAUDE_MODEL:-}" ]]; then
        cmd+=(--model "$AI_CLAUDE_MODEL")
    fi

    if [[ -n "${AI_CLAUDE_MAX_TURNS:-}" ]]; then
        cmd+=(--max-turns "$AI_CLAUDE_MAX_TURNS")
    fi

    # Tool restrictions: explicit env wins; otherwise tighten review/answer tasks.
    local allowed_tools="${AI_CLAUDE_ALLOWED_TOOLS:-}"
    if [[ -z "$allowed_tools" && "$task_type" == "review" ]]; then
        # Read/search + write for the review/answer artifact. No Bash → no git/gh.
        allowed_tools="${AI_CLAUDE_REVIEW_ALLOWED_TOOLS:-Read,Glob,Grep,Write,Edit}"
    fi
    if [[ -n "$allowed_tools" ]]; then
        cmd+=(--allowedTools "$allowed_tools")
    fi

    # Claude Code's Bash sandbox is bubblewrap (settings sandbox.enabled).
    # Default is off, but force it off whenever a nested namespace would fail
    # so file edits and shell tools keep working inside ai_isolation_exec.
    if ai_provider_nested_sandbox_blocked; then
        echo "WARNING: Claude Code nested sandbox unavailable; forcing sandbox.enabled=false (OS isolation via ai_isolation_exec remains)." >&2
        cmd+=(--settings '{"sandbox":{"enabled":false}}')
    fi

    if [[ -n "${AI_CLAUDE_EXTRA_ARGS:-}" ]]; then
        # shellcheck disable=SC2206
        local extra=($AI_CLAUDE_EXTRA_ARGS)
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
