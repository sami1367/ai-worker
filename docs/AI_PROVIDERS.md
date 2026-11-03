# AI providers — credentials and auth

Connect at least one provider under **Providers** (`/providers`). Secrets pasted in the UI are encrypted at rest, exported to the worker as `provider-credentials.env` (mode `0600`), and never shown again after save. The same variables can be set in compose `.env`; **UI/DB values override env** when both are set.

Enable a provider, connect credentials, set a **default**, then use **Test provider** to verify the CLI and wiring.

| Provider | Credential | Env vars |
|----------|------------|----------|
| Cursor CLI | Cursor API key | `CURSOR_API_KEY` |
| Claude Code | Anthropic API key and optional workspace id, **or** Claude OAuth token | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_WORKSPACE_ID` / `ANTHROPIC_CUSTOM_HEADERS`, or `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex CLI | OpenAI API key or ChatGPT account | API key variables, or device login in Providers |
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

## Codex

In **Providers → Codex CLI → Connect / change sign-in**, select a sign-in method:

- **ChatGPT account:** click **Sign in with ChatGPT**, open the displayed OpenAI link, and enter the one-time code. Enable device code login in ChatGPT security settings (or workspace permissions) if needed. The panel waits for completion, then enables Codex. Coding and review jobs use your plan's Codex allowance and limits.
- **OpenAI API key:** paste a key from platform.openai.com/api-keys and click **Connect**. Usage is billed to the API account. Existing environment keys remain supported.

Switching modes keeps your saved API key, so you can switch back without re-entering it. ChatGPT jobs remove API key overrides and enforce ChatGPT authentication; they never fall back to API billing. **Disconnect** in ChatGPT mode removes the local account cache and disables Codex. **Cancel sign-in** stops the pending login. A sign-in expires after 15 minutes; retry for a new code.

The Codex CLI stores the account session in `codex-account/` under the worker config directory (`/data/config` in Docker), with directory mode `0700`. This is the CLI's private token cache, separate from encrypted API keys in the database. The existing shared data volume preserves it across container recreation, and the worker can refresh the session there. Back up and protect it as credential material; never commit it. Login requires Codex CLI on the web server as well as the worker (included in the standard image). An in-progress code is held by the web process: after a web restart, start again or use the saved account if login had already completed. Use one web instance for the device login flow.

**Create Tasks planning** currently uses direct APIs and needs another enabled API provider when Codex is in ChatGPT mode. It does not charge a retained OpenAI key implicitly.

Official authentication guide: https://learn.chatgpt.com/docs/auth

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
