import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { providerConfigs } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { decryptSecret, encryptSecret } from '#utils/crypto'
import { writeAudit } from './audit'
import { exportProviderCredentialsForWorker } from './provider-credentials'

const execFileAsync = promisify(execFile)

const KNOWN = [
  { providerType: 'cursor', displayName: 'Cursor CLI' },
  { providerType: 'claude', displayName: 'Claude Code CLI' },
] as const

export async function ensureProviderRows() {
  const db = getDb()
  for (const p of KNOWN) {
    await db.insert(providerConfigs).values({
      providerType: p.providerType,
      displayName: p.displayName,
      isEnabled: true,
      isDefault: p.providerType === 'cursor',
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
  return false
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

  if (input.isDefault) {
    await db.update(providerConfigs).set({ isDefault: false })
  }

  const nextConfig = input.config ?? existing.config
  const [row] = await db.update(providerConfigs).set({
    isEnabled: input.isEnabled ?? existing.isEnabled,
    isDefault: input.isDefault ?? existing.isDefault,
    config: nextConfig,
    secretCiphertext,
    updatedAt: new Date(),
  }).where(eq(providerConfigs.providerType, providerType)).returning()

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
