import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { providerConfigs } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { decryptSecret, encryptSecret } from '#utils/crypto'
import { writeAudit } from './audit'
import { exportProviderCredentialsForWorker } from './provider-credentials'
import { getSettings, updateSettings } from './settings'

const execFileAsync = promisify(execFile)

const KNOWN = [
  { providerType: 'cursor', displayName: 'Cursor CLI' },
  { providerType: 'claude', displayName: 'Claude Code CLI' },
  { providerType: 'codex', displayName: 'Codex CLI' },
  { providerType: 'gemini', displayName: 'Gemini CLI' },
] as const

const KNOWN_TYPES = new Set(KNOWN.map((k) => k.providerType))

function isKnownProviderType(providerType: string): providerType is typeof KNOWN[number]['providerType'] {
  return KNOWN_TYPES.has(providerType as typeof KNOWN[number]['providerType'])
}

export async function ensureProviderRows() {
  const db = getDb()
  for (const p of KNOWN) {
    await db.insert(providerConfigs).values({
      providerType: p.providerType,
      displayName: p.displayName,
      // Providers stay off until the admin explicitly enables (and connects) them.
      isEnabled: false,
      isDefault: false,
      config: {},
    }).onConflictDoNothing({ target: providerConfigs.providerType })
  }
}

export async function listProviders() {
  await ensureProviderRows()
  const db = getDb()
  const rows = await db.select().from(providerConfigs)
  return rows.map(publicProvider)
}

function envCredentialPresent(providerType: string): boolean {
  if (providerType === 'cursor') return Boolean(process.env.CURSOR_API_KEY)
  if (providerType === 'claude') {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
  }
  if (providerType === 'codex') {
    return Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)
  }
  if (providerType === 'gemini') {
    return Boolean(process.env.GEMINI_API_KEY)
  }
  return false
}

function rowIsConnected(row: { providerType: string, secretCiphertext: string | null }) {
  return Boolean(row.secretCiphertext) || envCredentialPresent(row.providerType)
}

function publicProvider(row: typeof providerConfigs.$inferSelect) {
  const hasStoredSecret = Boolean(row.secretCiphertext)
  const hasEnvSecret = envCredentialPresent(row.providerType)
  return {
    id: row.id,
    providerType: row.providerType,
    displayName: row.displayName,
    isEnabled: row.isEnabled,
    isDefault: row.isDefault,
    config: row.config,
    hasSecret: hasStoredSecret || hasEnvSecret,
    hasStoredSecret,
    secretSource: hasStoredSecret ? 'stored' as const : hasEnvSecret ? 'env' as const : null,
    lastHealthCheckAt: row.lastHealthCheckAt,
    healthStatus: row.healthStatus,
    healthMessage: row.healthMessage,
    detectedVersion: row.detectedVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function syncDefaultAiProviderSetting(
  providerType: string,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  if (!isKnownProviderType(providerType)) return
  try {
    const current = await getSettings()
    if (current.defaultAiProvider !== providerType) {
      await updateSettings({ defaultAiProvider: providerType }, actor, ipHash)
    }
  } catch (err) {
    console.warn(
      '[providers] Failed to sync defaultAiProvider setting:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * After any provider mutation: if at least one enabled+connected provider exists,
 * exactly one of them must be the default. Otherwise clear all defaults.
 */
async function reconcileDefaultProvider(
  preferType?: string,
): Promise<typeof providerConfigs.$inferSelect | null> {
  const db = getDb()
  const rows = await db.select().from(providerConfigs)
  const candidates = rows.filter((r) => r.isEnabled && rowIsConnected(r))

  if (candidates.length === 0) {
    if (rows.some((r) => r.isDefault)) {
      await db.update(providerConfigs).set({ isDefault: false, updatedAt: new Date() })
    }
    return null
  }

  const defaults = candidates.filter((r) => r.isDefault)
  if (defaults.length === 1) return defaults[0]!

  const preferred = (preferType && candidates.find((r) => r.providerType === preferType))
    || candidates.find((r) => r.providerType === 'cursor')
    || candidates[0]!

  await db.update(providerConfigs).set({ isDefault: false, updatedAt: new Date() })
  const [promoted] = await db.update(providerConfigs).set({
    isDefault: true,
    updatedAt: new Date(),
  }).where(eq(providerConfigs.providerType, preferred.providerType)).returning()

  return promoted ?? null
}

export async function updateProvider(
  providerType: string,
  input: {
    isEnabled?: boolean
    isDefault?: boolean
    config?: Record<string, unknown>
    secret?: string | null
  },
  actor: { id: string, username: string },
  encryptionKey: string,
  ipHash?: string,
) {
  if (!KNOWN.some((k) => k.providerType === providerType)) {
    throw new AppError(404, 'Unknown provider', 'not_found')
  }
  await ensureProviderRows()
  const db = getDb()

  const [existing] = await db.select().from(providerConfigs)
    .where(eq(providerConfigs.providerType, providerType)).limit(1)
  if (!existing) throw new AppError(404, 'Unknown provider', 'not_found')

  let secretCiphertext = existing.secretCiphertext
  if (input.secret === null) {
    secretCiphertext = null
  } else if (typeof input.secret === 'string' && input.secret.length > 0) {
    if (!encryptionKey) throw new AppError(500, 'SECRET_ENCRYPTION_KEY is not configured', 'misconfigured')
    secretCiphertext = encryptSecret(input.secret, encryptionKey)
  }

  const nextEnabled = input.isEnabled ?? existing.isEnabled
  const willBeConnected = Boolean(secretCiphertext) || envCredentialPresent(providerType)
  let nextDefault = input.isDefault ?? existing.isDefault

  // Disabled or disconnected providers cannot be the default.
  if (!nextEnabled || !willBeConnected) nextDefault = false

  // Becoming default requires enabled + connected.
  if (input.isDefault === true && (!nextEnabled || !willBeConnected)) {
    throw new AppError(
      400,
      'Enable and connect the provider before making it the default',
      'validation_error',
    )
  }

  const allRows = await db.select().from(providerConfigs)
  const otherCandidates = allRows.filter((r) => (
    r.providerType !== providerType
    && r.isEnabled
    && rowIsConnected(r)
  ))

  // Unchecking the sole default is not allowed once a connected provider exists.
  if (existing.isDefault && input.isDefault === false && nextEnabled && willBeConnected) {
    if (otherCandidates.length === 0) {
      throw new AppError(
        400,
        'At least one connected provider must remain the default. Enable and select another provider first.',
        'validation_error',
      )
    }
    // Allow uncheck when another candidate can take over — reconcile will promote one.
    nextDefault = false
  }

  // First successful connect (or re-enable of the only connected provider) becomes default.
  if (nextEnabled && willBeConnected && !nextDefault && otherCandidates.every((r) => !r.isDefault)) {
    nextDefault = true
  }

  if (nextDefault) {
    await db.update(providerConfigs).set({ isDefault: false })
  }

  const nextConfig = input.config ?? existing.config
  const [updated] = await db.update(providerConfigs).set({
    isEnabled: nextEnabled,
    isDefault: nextDefault,
    config: nextConfig,
    secretCiphertext,
    updatedAt: new Date(),
  }).where(eq(providerConfigs.providerType, providerType)).returning()
  if (!updated) throw new AppError(500, 'Failed to update provider', 'internal')

  // Enforce exactly-one default among enabled+connected providers.
  const prefer = nextDefault || (typeof input.secret === 'string' && input.secret.length > 0)
    ? providerType
    : (input.isDefault === false ? otherCandidates[0]?.providerType : undefined)
  const reconciled = await reconcileDefaultProvider(prefer)
  let row = updated
  if (reconciled && reconciled.providerType === providerType) {
    row = reconciled
  } else {
    const [fresh] = await db.select().from(providerConfigs)
      .where(eq(providerConfigs.providerType, providerType)).limit(1)
    if (fresh) row = fresh
  }

  if (input.secret !== undefined) {
    try {
      await exportProviderCredentialsForWorker()
    } catch (err) {
      console.warn(
        '[providers] Failed to export provider credentials for worker:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Keep Settings.defaultAiProvider aligned with the resolved default provider.
  if (reconciled && isKnownProviderType(reconciled.providerType)) {
    await syncDefaultAiProviderSetting(reconciled.providerType, actor, ipHash)
  }

  if (input.secret !== undefined || input.isDefault !== undefined || input.isEnabled !== undefined) {
    try {
      const { applyWorkerRuntimeChange } = await import('./worker-runtime')
      await applyWorkerRuntimeChange('provider.update', {
        providerType,
        secretChanged: input.secret !== undefined,
        isDefault: row.isDefault,
      })
    } catch (err) {
      console.warn(
        '[providers] Failed to apply worker runtime change:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'provider.update',
    targetType: 'provider',
    targetId: providerType,
    metadata: {
      isEnabled: row.isEnabled,
      isDefault: row.isDefault,
      secretChanged: input.secret !== undefined,
      credentialType: typeof nextConfig?.credentialType === 'string' ? nextConfig.credentialType : undefined,
    },
    ipHash,
  })

  return publicProvider(row)
}

async function detectBinary(commands: string[]): Promise<{ bin: string | null, version: string | null }> {
  for (const cmd of commands) {
    try {
      const which = await execFileAsync('bash', ['-lc', `command -v ${cmd}`], { timeout: 5000 })
      const bin = which.stdout.trim()
      if (!bin) continue
      let version: string | null = null
      try {
        const v = await execFileAsync(bin, ['--version'], { timeout: 8000 })
        version = (v.stdout || v.stderr).trim().split('\n')[0]?.slice(0, 120) || null
      } catch {
        version = null
      }
      return { bin, version }
    } catch {
      // try next
    }
  }
  return { bin: null, version: null }
}

export async function testProvider(providerType: string) {
  await ensureProviderRows()
  const db = getDb()
  const [existing] = await db.select().from(providerConfigs)
    .where(eq(providerConfigs.providerType, providerType)).limit(1)
  if (!existing) throw new AppError(404, 'Unknown provider', 'not_found')

  let healthStatus: 'healthy' | 'degraded' | 'unhealthy'
  let healthMessage: string
  let detectedVersion: string | null

  if (providerType === 'cursor') {
    const { bin, version } = await detectBinary(['agent', 'cursor-agent'])
    detectedVersion = version
    if (!bin) {
      healthStatus = 'unhealthy'
      healthMessage = 'Cursor CLI not found (expected agent or cursor-agent on PATH)'
    } else {
      const hasCred = Boolean(process.env.CURSOR_API_KEY || existing.secretCiphertext)
      if (hasCred) {
        healthStatus = 'healthy'
        healthMessage = `Binary found at ${bin}. CURSOR_API_KEY is configured (not verified against the API).`
      } else {
        healthStatus = 'degraded'
        healthMessage = `Binary found at ${bin}. Connect a Cursor API key in Providers, or set CURSOR_API_KEY.`
      }
    }
  } else if (providerType === 'claude') {
    const { bin, version } = await detectBinary(['claude'])
    detectedVersion = version
    if (!bin) {
      healthStatus = 'unhealthy'
      healthMessage = 'Claude Code CLI not found (expected claude on PATH)'
    } else {
      const hasEnv = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || existing.secretCiphertext)
      if (hasEnv) {
        healthStatus = 'healthy'
        healthMessage = `Binary found at ${bin}. Credential material is configured (not verified against the API).`
      } else {
        healthStatus = 'degraded'
        healthMessage = `Binary found at ${bin}. Connect credentials in Providers, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.`
      }
    }
  } else if (providerType === 'codex') {
    const { bin, version } = await detectBinary(['codex'])
    detectedVersion = version
    if (!bin) {
      healthStatus = 'unhealthy'
      healthMessage = 'Codex CLI not found (expected codex on PATH)'
    } else {
      const hasCred = Boolean(
        process.env.OPENAI_API_KEY
        || process.env.CODEX_API_KEY
        || existing.secretCiphertext,
      )
      if (hasCred) {
        healthStatus = 'healthy'
        healthMessage = `Binary found at ${bin}. OpenAI/Codex API key is configured (not verified against the API).`
      } else {
        healthStatus = 'degraded'
        healthMessage = `Binary found at ${bin}. Connect an OpenAI API key in Providers, or set OPENAI_API_KEY / CODEX_API_KEY.`
      }
    }
  } else if (providerType === 'gemini') {
    const { bin, version } = await detectBinary(['gemini'])
    detectedVersion = version
    if (!bin) {
      healthStatus = 'unhealthy'
      healthMessage = 'Gemini CLI not found (expected gemini on PATH)'
    } else {
      const hasCred = Boolean(process.env.GEMINI_API_KEY || existing.secretCiphertext)
      if (hasCred) {
        healthStatus = 'healthy'
        healthMessage = `Binary found at ${bin}. GEMINI_API_KEY is configured (not verified against the API).`
      } else {
        healthStatus = 'degraded'
        healthMessage = `Binary found at ${bin}. Connect a Gemini API key in Providers, or set GEMINI_API_KEY.`
      }
    }
  } else {
    throw new AppError(404, 'Unknown provider', 'not_found')
  }

  const [row] = await db.update(providerConfigs).set({
    healthStatus,
    healthMessage,
    detectedVersion,
    lastHealthCheckAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(providerConfigs.providerType, providerType)).returning()

  return publicProvider(row)
}

export function providerSecretPlaintext(
  row: typeof providerConfigs.$inferSelect,
  encryptionKey: string,
): string | null {
  if (!row.secretCiphertext) return null
  return decryptSecret(row.secretCiphertext, encryptionKey)
}
