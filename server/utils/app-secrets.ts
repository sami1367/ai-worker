import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workerBaseDir } from '#utils/paths'

/** Published defaults that must never be accepted (removed from compose). */
export const KNOWN_INSECURE_SECRETS = [
  'changeme',
  'password',
  'secret',
  'admin',
  'n8Kx2mQ7pL4vR9wT1yH6jC3bF5dA0sE2uZ',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
  'wk_7f3a9c2e1b8d4f6a0e5c9b2d7a1f4e8c3b6d9e0a2f5c8',
  'Aw7kP9mX2qR5vN8jL3hC6tY1wE4uS0bZ',
] as const

export const SECRET_MIN_LENGTHS = {
  NUXT_SESSION_PASSWORD: 32,
  SESSION_SECRET: 32,
  SECRET_ENCRYPTION_KEY: 32,
  WORKER_INTERNAL_TOKEN: 32,
  INITIAL_ADMIN_BOOTSTRAP_SECRET: 16,
  POSTGRES_PASSWORD: 16,
} as const

export type AppSecretName =
  | 'DATABASE_URL'
  | 'NUXT_SESSION_PASSWORD'
  | 'SECRET_ENCRYPTION_KEY'
  | 'WORKER_INTERNAL_TOKEN'
  | 'INITIAL_ADMIN_BOOTSTRAP_SECRET'

export const PERSISTED_SECRET_KEYS = [
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'NUXT_SESSION_PASSWORD',
  'SESSION_SECRET',
  'SECRET_ENCRYPTION_KEY',
  'WORKER_INTERNAL_TOKEN',
  'INITIAL_ADMIN_BOOTSTRAP_SECRET',
] as const

export const APP_SECRETS_FILENAME = 'app-secrets.env'

export function appSecretsPath(baseDir = workerBaseDir()): string {
  return join(baseDir, APP_SECRETS_FILENAME)
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export function generateWorkerToken(): string {
  return `wk_${generateSecret(24)}`
}

export function isBlank(value: string | undefined | null): boolean {
  return !value || !value.trim()
}

export function isInsecureSecret(value: string | undefined | null, minLength = 16): boolean {
  if (isBlank(value)) return true
  const v = value!.trim()
  if (v.length < minLength) return true
  const lower = v.toLowerCase()
  if (KNOWN_INSECURE_SECRETS.some((s) => s.toLowerCase() === lower)) return true
  if (/^(changeme|password|secret|admin|test|default)[\d_-]*$/i.test(v)) return true
  if (/^(.)\1+$/.test(v)) return true
  return false
}

export function sessionPasswordFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NUXT_SESSION_PASSWORD || env.SESSION_SECRET || '').trim()
}

export type SecretIssue = {
  name: string
  reason: 'missing' | 'insecure'
}

/** Validate required runtime secrets. Does not include bootstrap (optional after setup). */
export function validateRequiredSecrets(env: NodeJS.ProcessEnv = process.env): SecretIssue[] {
  const issues: SecretIssue[] = []

  if (isBlank(env.DATABASE_URL)) {
    issues.push({ name: 'DATABASE_URL', reason: 'missing' })
  }

  const session = sessionPasswordFromEnv(env)
  if (isBlank(session)) {
    issues.push({ name: 'NUXT_SESSION_PASSWORD (or SESSION_SECRET)', reason: 'missing' })
  } else if (isInsecureSecret(session, SECRET_MIN_LENGTHS.NUXT_SESSION_PASSWORD)) {
    issues.push({ name: 'NUXT_SESSION_PASSWORD (or SESSION_SECRET)', reason: 'insecure' })
  }

  const enc = (env.SECRET_ENCRYPTION_KEY || '').trim()
  if (isBlank(enc)) {
    issues.push({ name: 'SECRET_ENCRYPTION_KEY', reason: 'missing' })
  } else if (isInsecureSecret(enc, SECRET_MIN_LENGTHS.SECRET_ENCRYPTION_KEY)) {
    issues.push({ name: 'SECRET_ENCRYPTION_KEY', reason: 'insecure' })
  }

  const worker = (env.WORKER_INTERNAL_TOKEN || '').trim()
  if (isBlank(worker)) {
    issues.push({ name: 'WORKER_INTERNAL_TOKEN', reason: 'missing' })
  } else if (isInsecureSecret(worker, SECRET_MIN_LENGTHS.WORKER_INTERNAL_TOKEN)) {
    issues.push({ name: 'WORKER_INTERNAL_TOKEN', reason: 'insecure' })
  }

  // Bootstrap is required only until an admin exists; still reject insecure values if set.
  const bootstrap = (env.INITIAL_ADMIN_BOOTSTRAP_SECRET || '').trim()
  if (!isBlank(bootstrap) && isInsecureSecret(bootstrap, SECRET_MIN_LENGTHS.INITIAL_ADMIN_BOOTSTRAP_SECRET)) {
    issues.push({ name: 'INITIAL_ADMIN_BOOTSTRAP_SECRET', reason: 'insecure' })
  }

  const pgPass = (env.POSTGRES_PASSWORD || '').trim()
  if (!isBlank(pgPass) && isInsecureSecret(pgPass, SECRET_MIN_LENGTHS.POSTGRES_PASSWORD)) {
    issues.push({ name: 'POSTGRES_PASSWORD', reason: 'insecure' })
  }

  return issues
}

export function formatSecretIssues(issues: SecretIssue[]): string {
  if (!issues.length) return ''
  const missing = issues.filter((i) => i.reason === 'missing').map((i) => i.name)
  const insecure = issues.filter((i) => i.reason === 'insecure').map((i) => i.name)
  const parts: string[] = []
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`)
  if (insecure.length) {
    parts.push(
      `insecure or too weak: ${insecure.join(', ')} `
      + '(do not use published defaults or values like "changeme"; run scripts/generate-env.sh)',
    )
  }
  return parts.join('; ')
}

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function serializeEnvFile(vars: Record<string, string>): string {
  const lines = [
    '# Persisted application secrets — mode 0600. Do not commit.',
    '# Host .env may be removed after first successful start; this file remains on the data volume.',
    '',
  ]
  for (const key of PERSISTED_SECRET_KEYS) {
    const value = vars[key]
    if (value !== undefined && value !== '') {
      lines.push(`${key}=${shellQuote(value)}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Fill empty process env keys from a persisted secrets file.
 * Non-empty environment values win (supports rotation via .env).
 */
export async function loadPersistedSecretsIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
  filePath = appSecretsPath(),
): Promise<{ loaded: boolean; filled: string[] }> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return { loaded: false, filled: [] }
  }
  const parsed = parseEnvFile(raw)
  const filled: string[] = []
  for (const key of PERSISTED_SECRET_KEYS) {
    const fromFile = parsed[key]
    if (!fromFile) continue
    if (isBlank(env[key])) {
      env[key] = fromFile
      filled.push(key)
    }
  }
  if (isBlank(env.NUXT_SESSION_PASSWORD) && !isBlank(env.SESSION_SECRET)) {
    env.NUXT_SESSION_PASSWORD = env.SESSION_SECRET
  }
  return { loaded: true, filled }
}

export async function persistSecretsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  filePath = appSecretsPath(),
): Promise<{ persisted: boolean; path: string }> {
  const vars: Record<string, string> = {}
  for (const key of PERSISTED_SECRET_KEYS) {
    const value = (env[key] || '').trim()
    if (value) vars[key] = value
  }
  if (isBlank(vars.NUXT_SESSION_PASSWORD) && vars.SESSION_SECRET) {
    vars.NUXT_SESSION_PASSWORD = vars.SESSION_SECRET
  }

  const requiredForPersist = [
    vars.DATABASE_URL,
    vars.NUXT_SESSION_PASSWORD || vars.SESSION_SECRET,
    vars.SECRET_ENCRYPTION_KEY,
    vars.WORKER_INTERNAL_TOKEN,
  ]
  if (requiredForPersist.some((v) => isBlank(v))) {
    return { persisted: false, path: filePath }
  }

  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  await writeFile(tmp, serializeEnvFile(vars), { encoding: 'utf8', mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, filePath)
  await chmod(filePath, 0o600)
  return { persisted: true, path: filePath }
}

export type EnsureAppSecretsResult = {
  ok: boolean
  issues: SecretIssue[]
  message: string
  filledFromDisk: string[]
  persisted: boolean
}

/**
 * Load persisted secrets, persist current env when complete, validate.
 * Never includes secret values in the returned message.
 */
export async function ensureAppSecrets(
  env: NodeJS.ProcessEnv = process.env,
  options: { persist?: boolean; filePath?: string } = {},
): Promise<EnsureAppSecretsResult> {
  const filePath = options.filePath ?? appSecretsPath()
  const { filled } = await loadPersistedSecretsIntoEnv(env, filePath)

  if (!env.NUXT_SESSION_PASSWORD && env.SESSION_SECRET) {
    env.NUXT_SESSION_PASSWORD = env.SESSION_SECRET
  }

  let persisted = false
  if (options.persist !== false) {
    const result = await persistSecretsFromEnv(env, filePath)
    persisted = result.persisted
  }

  const issues = validateRequiredSecrets(env)
  const message = issues.length
    ? `Invalid or incomplete application secrets (${formatSecretIssues(issues)})`
    : 'Application secrets ok'

  return {
    ok: issues.length === 0,
    issues,
    message,
    filledFromDisk: filled,
    persisted,
  }
}

/** Whether missing/insecure secrets should abort process startup. */
export function shouldFailOnSecretIssues(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AI_WORKER_ALLOW_INSECURE_SECRETS === '1') return false
  if (env.AI_WORKER_STRICT_SECRETS === '0') return false
  // Production and Docker always fail closed.
  if (env.NODE_ENV === 'production') return true
  if (env.AI_WORKER_STRICT_SECRETS === '1') return true
  // Fail closed whenever required secrets are partially configured (not a bare unit-test env).
  const anySet = Boolean(
    env.DATABASE_URL
    || env.NUXT_SESSION_PASSWORD
    || env.SESSION_SECRET
    || env.SECRET_ENCRYPTION_KEY
    || env.WORKER_INTERNAL_TOKEN,
  )
  return anySet
}
