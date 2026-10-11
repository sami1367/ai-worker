#!/usr/bin/env bash
# Prompt template loading and rendering. Source after lib/common.sh.
# Templates live in $WORKER_CODE_DIR/prompts/ — edit those files to change AI instructions.

# Code directory (this lib's parent). Runtime data may differ via BASE_DIR / AI_WORKER_BASE_DIR.
: "${WORKER_CODE_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ -z "${BASE_DIR:-}" ]]; then
  if [[ -n "${AI_WORKER_BASE_DIR:-}" ]]; then
    BASE_DIR="$AI_WORKER_BASE_DIR"
  else
    BASE_DIR="$WORKER_CODE_DIR"
  fi
fi

AI_PROMPT_VARS_FILE=""

ai_prompt_tmpfile() {
    local dir="${BASE_DIR}/state"
    mkdir -p "$dir"
    mktemp "${dir}/.ai-prompt.XXXXXX"
}

ai_prompts_dir() {
    printf '%s/prompts' "$WORKER_CODE_DIR"
}

ai_prompt_clear() {
    AI_PROMPT_VARS_FILE="$(ai_prompt_tmpfile)"
    printf '{}' > "$AI_PROMPT_VARS_FILE"
}

# Set a template variable (replaces {{NAME}} in templates).
ai_prompt_set() {
    local name="$1"
    local value="$2"
    local next

    if [[ -z "$AI_PROMPT_VARS_FILE" ]]; then
        ai_prompt_clear
    fi

    next="${AI_PROMPT_VARS_FILE}.new"
    jq \
        --arg k "$name" \
        --arg v "$value" \
        '. + {($k): $v}' \
        "$AI_PROMPT_VARS_FILE" > "$next"
    mv "$next" "$AI_PROMPT_VARS_FILE"
}

# Expand {{INCLUDE:relative/path.txt}} lines recursively.
ai_prompt_expand_includes() {
    local file="$1"
    local prompts_dir line include_rel include_path

    prompts_dir="$(ai_prompts_dir)"

    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^\{\{INCLUDE:([^}]+)\}\}[[:space:]]*$ ]]; then
            include_rel="${BASH_REMATCH[1]}"
            include_path="${prompts_dir}/${include_rel}"
            if [[ ! -f "$include_path" ]]; then
                echo "ERROR: Prompt include not found: $include_path" >&2
                return 1
            fi
            ai_prompt_expand_includes "$include_path" || return 1
        else
            printf '%s\n' "$line"
        fi
    done < "$file"
}

# Substitute {{VAR}} placeholders using stored variables (python3 for safe multiline).
ai_prompt_substitute() {
    local content="$1"
    local vars_json tmp_in tmp_out

    if ! command -v python3 >/dev/null 2>&1; then
        echo "ERROR: python3 is required to render prompt templates." >&2
        return 1
    fi

    if [[ -z "$AI_PROMPT_VARS_FILE" || ! -f "$AI_PROMPT_VARS_FILE" ]]; then
        printf '%s' "$content"
        return 0
    fi

    vars_json="$(cat "$AI_PROMPT_VARS_FILE")"
    if [[ "$vars_json" == "{}" ]]; then
        printf '%s' "$content"
        return 0
    fi

    tmp_in="$(ai_prompt_tmpfile)"
    tmp_out="$(ai_prompt_tmpfile)"
    printf '%s' "$content" > "$tmp_in"

    python3 - "$AI_PROMPT_VARS_FILE" "$tmp_in" "$tmp_out" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    variables = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f:
    content = f.read()

for key, value in variables.items():
    content = content.replace("{{" + key + "}}", value)

with open(sys.argv[3], "w", encoding="utf-8") as f:
    f.write(content)
PY

    cat "$tmp_out"
    rm -f "$tmp_in" "$tmp_out"
}

# Render a template (relative to prompts/) to an output file.
ai_prompt_render() {
    local template_rel="$1"
    local output_file="$2"
    local prompts_dir template_path expanded content

    prompts_dir="$(ai_prompts_dir)"
    template_path="${prompts_dir}/${template_rel}"

    if [[ ! -f "$template_path" ]]; then
        echo "ERROR: Prompt template not found: $template_path" >&2
        return 1
    fi

    expanded="$(ai_prompt_expand_includes "$template_path")" || return 1
    content="$(ai_prompt_substitute "$expanded")" || return 1

    mkdir -p "$(dirname "$output_file")"
    printf '%s' "$content" > "$output_file"

    if [[ -n "$AI_PROMPT_VARS_FILE" ]]; then
        rm -f "$AI_PROMPT_VARS_FILE"
        AI_PROMPT_VARS_FILE=""
    fi
}
