#!/usr/bin/env bash
# Prompt template loading and rendering. Source after lib/common.sh.
# Source of truth is the platform DB (seeded from worker/prompts/).
# Before each render the worker fetches live content via the internal API.

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
AI_PROMPTS_LIVE_DIR=""

ai_prompt_tmpfile() {
    local dir="${BASE_DIR}/state"
    mkdir -p "$dir"
    mktemp "${dir}/.ai-prompt.XXXXXX"
}

# Seed files shipped with the image/checkout (fallback when API is unavailable).
ai_prompt_seed_dir() {
    printf '%s/prompts' "$WORKER_CODE_DIR"
}

ai_prompts_dir() {
    if [[ -n "${AI_PROMPTS_LIVE_DIR:-}" && -d "$AI_PROMPTS_LIVE_DIR" ]]; then
        printf '%s' "$AI_PROMPTS_LIVE_DIR"
        return 0
    fi
    ai_prompt_seed_dir
}

# Fetch all prompts from the platform DB and materialize into a live cache dir.
# Safe to call before every job; falls back to seed files on failure.
ai_prompt_fetch_from_db() {
    local web_url token body tmp_dir dest_dir item_count

    web_url="${WEB_INTERNAL_URL:-}"
    token="${WORKER_INTERNAL_TOKEN:-}"

    if [[ -z "$web_url" || -z "$token" ]]; then
        echo "WARNING: Prompt DB fetch skipped (WEB_INTERNAL_URL / WORKER_INTERNAL_TOKEN unset); using seed files" >&2
        AI_PROMPTS_LIVE_DIR=""
        return 1
    fi

    if ! command -v python3 >/dev/null 2>&1; then
        echo "WARNING: python3 required to sync prompts from DB; using seed files" >&2
        AI_PROMPTS_LIVE_DIR=""
        return 1
    fi

    body="$(
        curl -fsS \
            -H "Accept: application/json" \
            -H "x-worker-token: $token" \
            "${web_url}/api/v1/worker/internal/prompts" 2>/dev/null || true
    )"

    if [[ -z "$body" ]]; then
        echo "WARNING: Prompt DB fetch failed; using seed files" >&2
        AI_PROMPTS_LIVE_DIR=""
        return 1
    fi

    item_count="$(jq -r '.items | length // 0' <<<"$body" 2>/dev/null || echo 0)"
    if [[ ! "$item_count" =~ ^[0-9]+$ ]] || [[ "$item_count" -lt 1 ]]; then
        echo "WARNING: Prompt DB returned no items; using seed files" >&2
        AI_PROMPTS_LIVE_DIR=""
        return 1
    fi

    dest_dir="${BASE_DIR}/state/prompts-live"
    tmp_dir="${dest_dir}.tmp.$$"
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"

    if ! python3 - "$body" "$tmp_dir" <<'PY'
import json, os, sys

payload = json.loads(sys.argv[1])
out_dir = sys.argv[2]
items = payload.get("items") or []
if not items:
    raise SystemExit(1)

for item in items:
    rel = item.get("path") or ""
    content = item.get("content")
    if not rel or content is None:
        continue
    # Refuse path escape
    if ".." in rel.split("/") or rel.startswith("/") or "\\" in rel:
        raise SystemExit(f"unsafe prompt path: {rel!r}")
    full = os.path.join(out_dir, rel)
    os.makedirs(os.path.dirname(full) or out_dir, exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)
PY
    then
        echo "WARNING: Failed to materialize prompts from DB; using seed files" >&2
        rm -rf "$tmp_dir"
        AI_PROMPTS_LIVE_DIR=""
        return 1
    fi

    rm -rf "$dest_dir"
    mv "$tmp_dir" "$dest_dir"
    AI_PROMPTS_LIVE_DIR="$dest_dir"
    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Synced ${item_count} prompts from database"
    return 0
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
# Fetches latest prompt content from the database before rendering.
ai_prompt_render() {
    local template_rel="$1"
    local output_file="$2"
    local prompts_dir template_path expanded content

    # Live DB fetch each job — edits in the UI apply without worker restart.
    ai_prompt_fetch_from_db || true

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
