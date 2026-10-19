import { chmod, mkdir, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { providerConfigs } from '#db/schema'
import { getDb } from '#utils/db'
import { decryptSecret } from '#utils/crypto'
import { workerBaseDir } from '#utils/paths'

export type ClaudeCredentialType = 'anthropic_api_key' | 'claude_oauth_token'

/** Normalize Anthropic workspace ids (wrkspc_…). Empty / invalid → ''. */
export function normalizeAnthropicWorkspaceId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().slice(0, 128)
  if (!trimmed) return ''
  // Accept Console IDs; also allow bare ids that already include the prefix.
  if (/^wrkspc_[A-Za-z0-9]+$/.test(trimmed)) return trimmed
  if (/^[A-Za-z0-9]+$/.test(trimmed) && !trimmed.startsWith('wrkspc_')) {
    // Operators sometimes paste the suffix only — keep as-is; Anthropic validates.
    return trimmed
  }
  return trimmed
}

/**
 * Build Claude Code custom headers for multi-workspace / unscoped API keys.
 * Prefers Providers UI workspace id, then ANTHROPIC_WORKSPACE_ID, then existing
 * ANTHROPIC_CUSTOM_HEADERS from the environment.
 */
export function resolveAnthropicCustomHeaders(opts: {
  apiKeyPresent: boolean
  workspaceId?: string | null
  envWorkspaceId?: string | null
  envCustomHeaders?: string | null
}): string {
  if (!opts.apiKeyPresent) return ''
  const fromConfig = normalizeAnthropicWorkspaceId(opts.workspaceId)
  const fromEnv = normalizeAnthropicWorkspaceId(opts.envWorkspaceId)
  const workspaceId = fromConfig || fromEnv
  if (workspaceId) return `anthropic-workspace-id: ${workspaceId}`
  const existing = typeof opts.envCustomHeaders === 'string' ? opts.envCustomHeaders.trim() : ''
  return existing.slice(0, 512)
}

/**
 * Materialize AI provider secrets for the Bash worker into a 0600 env file
 * on the shared config volume. Secrets are never written into project conf JSON.
 */
export async function exportProviderCredentialsForWorker(): Promise<{
  path: string
  cursor: boolean
  claude: boolean
  codex: boolean
  gemini: boolean
  copilot: boolean
}> {
  const db = getDb()
  const rows = await db.select().from(providerConfigs)
  const key = process.env.SECRET_ENCRYPTION_KEY || ''

  let cursorKey = process.env.CURSOR_API_KEY || ''
  let anthropicKey = process.env.ANTHROPIC_API_KEY || ''
  let claudeOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN || ''
  let openaiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || ''
  let geminiKey = process.env.GEMINI_API_KEY || ''
  let copilotToken = process.env.COPILOT_GITHUB_TOKEN || ''
  let anthropicWorkspaceId = normalizeAnthropicWorkspaceId(process.env.ANTHROPIC_WORKSPACE_ID)

  const cursor = rows.find((r) => r.providerType === 'cursor')
  const claude = rows.find((r) => r.providerType === 'claude')
  const codex = rows.find((r) => r.providerType === 'codex')
  const gemini = rows.find((r) => r.providerType === 'gemini')
  const copilot = rows.find((r) => r.providerType === 'copilot')

  if (cursor?.secretCiphertext && key) {
    try {
      cursorKey = decryptSecret(cursor.secretCiphertext, key)
    } catch {
      // Keep env fallback
    }
  }

  if (claude?.secretCiphertext && key) {
    try {
      const plaintext = decryptSecret(claude.secretCiphertext, key)
      const kind = (claude.config?.credentialType as ClaudeCredentialType | undefined)
        || 'anthropic_api_key'
      if (kind === 'claude_oauth_token') {
        claudeOauth = plaintext
        // Prefer the stored OAuth token over a stale env API key for headless runs.
        anthropicKey = process.env.ANTHROPIC_API_KEY || ''
      } else {
        anthropicKey = plaintext
      }
    } catch {
      // Keep env fallback
    }
  }

  const configWorkspace = normalizeAnthropicWorkspaceId(claude?.config?.anthropicWorkspaceId)
  if (configWorkspace) anthropicWorkspaceId = configWorkspace

  if (codex?.secretCiphertext && key) {
    try {
      openaiKey = decryptSecret(codex.secretCiphertext, key)
    } catch {
      // Keep env fallback
    }
  }

  if (gemini?.secretCiphertext && key) {
    try {
      geminiKey = decryptSecret(gemini.secretCiphertext, key)
    } catch {
      // Keep env fallback
    }
  }

  if (copilot?.secretCiphertext && key) {
    try {
      copilotToken = decryptSecret(copilot.secretCiphertext, key)
    } catch {
      // Keep env fallback
    }
  }

  const anthropicCustomHeaders = resolveAnthropicCustomHeaders({
    apiKeyPresent: Boolean(anthropicKey),
    workspaceId: anthropicWorkspaceId,
    envWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
    envCustomHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS,
  })

  const base = workerBaseDir()
  await mkdir(base, { recursive: true })
  const target = join(base, 'provider-credentials.env')
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`

  // Export both OPENAI_API_KEY and CODEX_API_KEY (same value). Codex exec prefers
  // CODEX_API_KEY for non-interactive auth; OPENAI_API_KEY covers broader tooling.
  // Copilot uses COPILOT_GITHUB_TOKEN (not GH_TOKEN) so agent isolation can strip forge tokens.
  // ANTHROPIC_CUSTOM_HEADERS carries anthropic-workspace-id for unscoped org API keys.
  const lines = [
    '# Generated by AI Worker Platform — do not edit. Mode 0600.',
    '# Sourced by the worker entrypoint and each poll cycle. Never commit this file.',
    cursorKey ? `export CURSOR_API_KEY=${shellQuote(cursorKey)}` : '# CURSOR_API_KEY unset',
    anthropicKey ? `export ANTHROPIC_API_KEY=${shellQuote(anthropicKey)}` : '# ANTHROPIC_API_KEY unset',
    claudeOauth ? `export CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(claudeOauth)}` : '# CLAUDE_CODE_OAUTH_TOKEN unset',
    anthropicCustomHeaders
      ? `export ANTHROPIC_CUSTOM_HEADERS=${shellQuote(anthropicCustomHeaders)}`
      : '# ANTHROPIC_CUSTOM_HEADERS unset',
    openaiKey ? `export OPENAI_API_KEY=${shellQuote(openaiKey)}` : '# OPENAI_API_KEY unset',
    openaiKey ? `export CODEX_API_KEY=${shellQuote(openaiKey)}` : '# CODEX_API_KEY unset',
    geminiKey ? `export GEMINI_API_KEY=${shellQuote(geminiKey)}` : '# GEMINI_API_KEY unset',
    copilotToken ? `export COPILOT_GITHUB_TOKEN=${shellQuote(copilotToken)}` : '# COPILOT_GITHUB_TOKEN unset',
    '',
  ]
  await writeFile(tmp, lines.join('\n'), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, target)
  await chmod(target, 0o600)

  return {
    path: target,
    cursor: Boolean(cursorKey),
    claude: Boolean(anthropicKey || claudeOauth),
    codex: Boolean(openaiKey),
    gemini: Boolean(geminiKey),
    copilot: Boolean(copilotToken),
  }
}

/** Export provider credentials and wake the worker so keys apply on the next poll. */
export async function exportProviderCredentialsAndWake(reason = 'provider.credentials'): Promise<void> {
  await exportProviderCredentialsForWorker()
  try {
    const { applyWorkerRuntimeChange } = await import('./worker-runtime')
    await applyWorkerRuntimeChange(reason, { provider: true })
  } catch {
    // wake is best-effort
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function clearProviderCredentialsFile(): Promise<void> {
  try {
    await unlink(join(workerBaseDir(), 'provider-credentials.env'))
  } catch {
    // ignore
  }
}
