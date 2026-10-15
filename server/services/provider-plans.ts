import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { providerConfigs } from '#db/schema'
import { getDb } from '#utils/db'
import { decryptSecret } from '#utils/crypto'
import type { ClaudeCredentialType } from './provider-credentials'

const execFileAsync = promisify(execFile)

export type ProviderPlanSnapshot = {
  providerType: 'cursor' | 'claude' | 'codex' | 'gemini'
  displayName: string
  plan: string | null
  email: string | null
  model: string | null
  cliVersion: string | null
  authenticated: boolean | null
  authMethod: string | null
  apiKeyName: string | null
  accountLabel: string | null
  source: 'cli' | 'api' | 'none'
  fetchedAt: string
  error: string | null
}

type ResolvedSecrets = {
  cursorApiKey: string
  anthropicApiKey: string
  claudeOauthToken: string
  openaiApiKey: string
  geminiApiKey: string
}

async function resolveProviderSecrets(): Promise<ResolvedSecrets> {
  const db = getDb()
  const rows = await db.select().from(providerConfigs)
  const key = process.env.SECRET_ENCRYPTION_KEY || ''

  let cursorApiKey = process.env.CURSOR_API_KEY || ''
  let anthropicApiKey = process.env.ANTHROPIC_API_KEY || ''
  let claudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || ''
  let openaiApiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || ''
  let geminiApiKey = process.env.GEMINI_API_KEY || ''

  const cursor = rows.find((r) => r.providerType === 'cursor')
  const claude = rows.find((r) => r.providerType === 'claude')
  const codex = rows.find((r) => r.providerType === 'codex')
  const gemini = rows.find((r) => r.providerType === 'gemini')

  if (cursor?.secretCiphertext && key) {
    try {
      cursorApiKey = decryptSecret(cursor.secretCiphertext, key)
    } catch {
      // keep env
    }
  }

  if (claude?.secretCiphertext && key) {
    try {
      const plaintext = decryptSecret(claude.secretCiphertext, key)
      const kind = (claude.config?.credentialType as ClaudeCredentialType | undefined)
        || 'anthropic_api_key'
      if (kind === 'claude_oauth_token') {
        claudeOauthToken = plaintext
      } else {
        anthropicApiKey = plaintext
      }
    } catch {
      // keep env
    }
  }

  if (codex?.secretCiphertext && key) {
    try {
      openaiApiKey = decryptSecret(codex.secretCiphertext, key)
    } catch {
      // keep env
    }
  }

  if (gemini?.secretCiphertext && key) {
    try {
      geminiApiKey = decryptSecret(gemini.secretCiphertext, key)
    } catch {
      // keep env
    }
  }

  return { cursorApiKey, anthropicApiKey, claudeOauthToken, openaiApiKey, geminiApiKey }
}

async function detectBin(commands: string[]): Promise<string | null> {
  for (const cmd of commands) {
    try {
      const which = await execFileAsync('bash', ['-lc', `command -v ${cmd}`], { timeout: 4000 })
      const bin = which.stdout.trim()
      if (bin) return bin
    } catch {
      // try next
    }
  }
  return null
}

function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(extra)) {
    if (v) env[k] = v
    else delete env[k]
  }
  // Avoid leaking unrelated secrets into CLI subprocesses beyond what we set.
  return env
}

async function fetchCursorPlan(secrets: ResolvedSecrets): Promise<ProviderPlanSnapshot> {
  const fetchedAt = new Date().toISOString()
  const base: ProviderPlanSnapshot = {
    providerType: 'cursor',
    displayName: 'Cursor CLI',
    plan: null,
    email: null,
    model: null,
    cliVersion: null,
    authenticated: null,
    authMethod: secrets.cursorApiKey ? 'api_key' : null,
    apiKeyName: null,
    accountLabel: null,
    source: 'none',
    fetchedAt,
    error: null,
  }

  if (!secrets.cursorApiKey) {
    base.error = 'No Cursor API key configured'
    return base
  }

  // Prefer CLI about (includes subscription tier); enrich/fall back via Cloud Agents /v1/me.
  // Fresh containers sometimes return Unknown/Not logged in on the first call — retry once.
  const bin = await detectBin(['agent', 'cursor-agent'])
  if (bin) {
    const env = childEnv({ CURSOR_API_KEY: secrets.cursorApiKey })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 800))
        const { stdout } = await execFileAsync(bin, ['about', '--format', 'json'], {
          timeout: 12_000,
          env,
          maxBuffer: 512_000,
        })
        const data = JSON.parse(stdout) as Record<string, unknown>
        base.source = 'cli'
        const tier = typeof data.subscriptionTier === 'string' ? data.subscriptionTier.trim() : ''
        base.plan = tier && tier.toLowerCase() !== 'unknown' ? tier : null
        const email = typeof data.userEmail === 'string' ? data.userEmail.trim() : ''
        base.email = email && email.toLowerCase() !== 'not logged in' ? email : null
        base.model = typeof data.model === 'string' ? data.model : null
        base.cliVersion = typeof data.cliVersion === 'string' ? data.cliVersion : null
        base.authenticated = Boolean(base.email)
        base.accountLabel = base.email
        base.error = null
        if (base.plan && base.email) return base
      } catch (err) {
        base.error = err instanceof Error ? err.message.slice(0, 200) : 'Failed to read Cursor plan via CLI'
      }
    }
  }

  try {
    const res = await fetch('https://api.cursor.com/v1/me', {
      headers: { Authorization: `Bearer ${secrets.cursorApiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      if (!base.plan && !base.email) {
        base.error = `Cursor API /v1/me returned ${res.status}`
      }
      return base
    }
    const data = await res.json() as Record<string, unknown>
    if (!base.source) base.source = 'api'
    base.authenticated = true
    if (!base.email && typeof data.userEmail === 'string') base.email = data.userEmail
    base.apiKeyName = typeof data.apiKeyName === 'string' ? data.apiKeyName : null
    base.accountLabel = base.email || base.apiKeyName
    // User API keys do not expose subscription tier; keep CLI plan when present.
    base.error = null
    return base
  } catch (err) {
    if (!base.plan && !base.email) {
      base.error = err instanceof Error ? err.message.slice(0, 200) : 'Failed to read Cursor account'
    }
    return base
  }
}

async function fetchClaudePlan(secrets: ResolvedSecrets): Promise<ProviderPlanSnapshot> {
  const fetchedAt = new Date().toISOString()
  const hasCred = Boolean(secrets.anthropicApiKey || secrets.claudeOauthToken)
  const base: ProviderPlanSnapshot = {
    providerType: 'claude',
    displayName: 'Claude Code CLI',
    plan: null,
    email: null,
    model: null,
    cliVersion: null,
    authenticated: null,
    authMethod: secrets.claudeOauthToken
      ? 'oauth_token'
      : secrets.anthropicApiKey
        ? 'api_key'
        : null,
    apiKeyName: null,
    accountLabel: null,
    source: 'none',
    fetchedAt,
    error: null,
  }

  if (!hasCred) {
    base.error = 'No Claude credentials configured'
    return base
  }

  const bin = await detectBin(['claude'])
  if (!bin) {
    base.error = 'Claude Code CLI not found on PATH'
    return base
  }

  try {
    const version = await execFileAsync(bin, ['--version'], {
      timeout: 8000,
      env: childEnv({
        ANTHROPIC_API_KEY: secrets.anthropicApiKey || undefined,
        CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeOauthToken || undefined,
      }),
    })
    base.cliVersion = (version.stdout || version.stderr).trim().split('\n')[0]?.slice(0, 80) || null
  } catch {
    // version optional
  }

  try {
    const { stdout } = await execFileAsync(bin, ['auth', 'status', '--json'], {
      timeout: 12_000,
      env: childEnv({
        ANTHROPIC_API_KEY: secrets.anthropicApiKey || undefined,
        CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeOauthToken || undefined,
      }),
      maxBuffer: 512_000,
    })
    const data = JSON.parse(stdout) as Record<string, unknown>
    base.source = 'cli'
    base.authenticated = Boolean(data.loggedIn)
    if (typeof data.authMethod === 'string') base.authMethod = data.authMethod
    // Claude Code Max / Pro plan is only exposed for some auth methods; API keys are usage-billed.
    const planCandidate = data.subscriptionType
      ?? data.subscriptionTier
      ?? data.plan
      ?? data.accountType
    base.plan = typeof planCandidate === 'string'
      ? planCandidate
      : base.authMethod === 'api_key'
        ? 'API usage'
        : base.authenticated
          ? 'Authenticated'
          : null
    base.accountLabel = base.authMethod === 'api_key'
      ? 'Anthropic API key'
      : base.authMethod === 'oauth_token' || base.authMethod === 'claude_ai'
        ? 'Claude account'
        : null
    if (!base.authenticated) {
      base.error = 'Claude CLI reports not logged in'
    }
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message.slice(0, 200) : 'Failed to read Claude auth status'
    return base
  }
}

async function fetchCodexPlan(secrets: ResolvedSecrets): Promise<ProviderPlanSnapshot> {
  const fetchedAt = new Date().toISOString()
  const base: ProviderPlanSnapshot = {
    providerType: 'codex',
    displayName: 'Codex CLI',
    plan: null,
    email: null,
    model: null,
    cliVersion: null,
    authenticated: null,
    authMethod: secrets.openaiApiKey ? 'api_key' : null,
    apiKeyName: null,
    accountLabel: null,
    source: 'none',
    fetchedAt,
    error: null,
  }

  if (!secrets.openaiApiKey) {
    base.error = 'No OpenAI/Codex API key configured'
    return base
  }

  const bin = await detectBin(['codex'])
  if (!bin) {
    base.error = 'Codex CLI not found on PATH'
    return base
  }

  try {
    const version = await execFileAsync(bin, ['--version'], {
      timeout: 8000,
      env: childEnv({
        OPENAI_API_KEY: secrets.openaiApiKey,
        CODEX_API_KEY: secrets.openaiApiKey,
      }),
    })
    base.cliVersion = (version.stdout || version.stderr).trim().split('\n')[0]?.slice(0, 80) || null
    base.source = 'cli'
    base.authenticated = true
    base.plan = 'API usage'
    base.accountLabel = 'OpenAI API key'
    base.error = null
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message.slice(0, 200) : 'Failed to read Codex CLI version'
    // Key is present even if --version failed for unrelated reasons.
    base.authenticated = true
    base.plan = 'API usage'
    base.accountLabel = 'OpenAI API key'
    return base
  }
}

async function fetchGeminiPlan(secrets: ResolvedSecrets): Promise<ProviderPlanSnapshot> {
  const fetchedAt = new Date().toISOString()
  const base: ProviderPlanSnapshot = {
    providerType: 'gemini',
    displayName: 'Gemini CLI',
    plan: null,
    email: null,
    model: null,
    cliVersion: null,
    authenticated: null,
    authMethod: secrets.geminiApiKey ? 'api_key' : null,
    apiKeyName: null,
    accountLabel: null,
    source: 'none',
    fetchedAt,
    error: null,
  }

  if (!secrets.geminiApiKey) {
    base.error = 'No Gemini API key configured'
    return base
  }

  const bin = await detectBin(['gemini'])
  if (!bin) {
    base.error = 'Gemini CLI not found on PATH'
    return base
  }

  try {
    const version = await execFileAsync(bin, ['--version'], {
      timeout: 8000,
      env: childEnv({ GEMINI_API_KEY: secrets.geminiApiKey }),
    })
    base.cliVersion = (version.stdout || version.stderr).trim().split('\n')[0]?.slice(0, 80) || null
    base.source = 'cli'
    base.authenticated = true
    base.plan = 'API usage'
    base.accountLabel = 'Gemini API key'
    base.error = null
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message.slice(0, 200) : 'Failed to read Gemini CLI version'
    base.authenticated = true
    base.plan = 'API usage'
    base.accountLabel = 'Gemini API key'
    return base
  }
}

/** Best-effort plan / account snapshots for each AI provider (parallel, timed). */
export async function getProviderPlanSnapshots(): Promise<ProviderPlanSnapshot[]> {
  const secrets = await resolveProviderSecrets()
  const [cursor, claude, codex, gemini] = await Promise.all([
    fetchCursorPlan(secrets),
    fetchClaudePlan(secrets),
    fetchCodexPlan(secrets),
    fetchGeminiPlan(secrets),
  ])
  return [cursor, claude, codex, gemini]
}
