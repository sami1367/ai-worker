# AI providers — credentials and auth

Connect at least one provider under **Providers** (`/providers`). Secrets pasted in the UI are encrypted at rest, exported to the worker as `provider-credentials.env` (mode `0600`), and never shown again after save. The same variables can be set in compose `.env`; **UI/DB values override env** when both are set.

Enable a provider, connect credentials, set a **default**, then use **Test provider** to verify the CLI and wiring.

| Provider | Credential | Env vars |
|----------|------------|----------|
| Cursor CLI | Cursor API key | `CURSOR_API_KEY` |
| Claude Code | Anthropic API key and optional workspace id, **or** Claude OAuth token | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_WORKSPACE_ID` / `ANTHROPIC_CUSTOM_HEADERS`, or `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex CLI | OpenAI API key | `OPENAI_API_KEY` or `CODEX_API_KEY` |
| Gemini CLI | Gemini API key | `GEMINI_API_KEY` |
| GitHub Copilot CLI | Fine-grained GitHub PAT with **Copilot Requests** | `COPILOT_GITHUB_TOKEN` |

---

## Claude Code (detailed)

Claude Code supports two auth modes. Prefer an **API key** for headless Docker workers.

### Option A — Anthropic API key (recommended)

1. Open [Claude Console](https://platform.claude.com) → **Workspaces**.
2. Create or select a workspace; copy its id if shown (`wrkspc_…`).
3. Create an API key **scoped to that workspace** when possible.
4. On **Providers → Claude Code**:
   - Credential type: **Anthropic API key**
   - Paste `sk-ant-…`
   - If Anthropic returns *“API key is not scoped to a workspace”*, fill **Anthropic workspace ID** with `wrkspc_…`, then **Save** or **Connect** again
5. Enable Claude, set it as default if desired, **Test provider**, restart/wake the worker if needed.

The platform exports:

- `ANTHROPIC_API_KEY`
- when a workspace id is set: `ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: wrkspc_…`

You can also set in compose `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-…
ANTHROPIC_WORKSPACE_ID=wrkspc_…
# or, equivalently:
# ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: wrkspc_…
```

With an API key present, the worker runs Claude with `--bare` (skips project hooks/MCP discovery for reproducible CI).

### Option B — Claude OAuth token (subscription)

Use this for Claude Pro / Max style auth via `claude setup-token`, **not** for pasting an API key.

1. On a machine with Claude Code installed and logged in, run: `claude setup-token`
2. Copy the token output.
3. On **Providers → Claude Code**:
   - Credential type: **Claude OAuth token**
   - Paste the token (do **not** paste `sk-ant-…` here)
4. Connect, enable, test.

Exported as `CLAUDE_CODE_OAUTH_TOKEN`. Claude Code **`--bare` ignores OAuth**, so the worker intentionally omits `--bare` when only an OAuth token is available.

---

## Cursor CLI

1. Create an API key in the Cursor dashboard (Settings → API Keys).
2. Paste on Providers (or set `CURSOR_API_KEY` in `.env`).
3. Enable, set default if needed, Test.

---

## Codex CLI

1. Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Paste on Providers (exports both `OPENAI_API_KEY` and `CODEX_API_KEY`).
3. Enable, Test.

---

## Gemini CLI

1. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Paste on Providers or set `GEMINI_API_KEY`.
3. Enable, Test.

---

## GitHub Copilot CLI

1. Create a **fine-grained** GitHub PAT with the **Copilot Requests** permission.
2. Classic `ghp_` tokens are **not** supported.
3. Paste on Providers as `COPILOT_GITHUB_TOKEN` — do **not** reuse forge `GITHUB_TOKEN` / `GH_TOKEN` (agent isolation strips forge tokens).
4. Enable, Test.

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `Not logged in · Please run /login` with Claude `--bare` | Use an Anthropic **API key**, or connect a real OAuth **setup-token** (worker omits `--bare` for OAuth). |
| `API key is not scoped to a workspace` | Create a workspace-scoped key, **or** set **Anthropic workspace ID** / `ANTHROPIC_WORKSPACE_ID`. |
| Provider shows connected but worker still fails | Confirm credentials were saved after the latest UI change; wake/restart the worker so `provider-credentials.env` is re-sourced. |
| Copilot auth fails | Confirm fine-grained PAT + Copilot Requests; not a classic PAT and not the forge token. |
