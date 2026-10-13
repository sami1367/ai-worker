import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_SECRETS_FILENAME,
  ensureAppSecrets,
  formatSecretIssues,
  generateSecret,
  generateWorkerToken,
  isInsecureSecret,
  KNOWN_INSECURE_SECRETS,
  loadPersistedSecretsIntoEnv,
  persistSecretsFromEnv,
  SECRET_MIN_LENGTHS,
  shouldFailOnSecretIssues,
  validateRequiredSecrets,
} from '../../server/utils/app-secrets'

describe('app-secrets', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'ai-worker-secrets-'))
    dirs.push(dir)
    return dir
  }

  function strongEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const pg = generateSecret(16)
    return {
      DATABASE_URL: `postgresql://aiworker:${pg}@db:5432/aiworker`,
      POSTGRES_PASSWORD: pg,
      NUXT_SESSION_PASSWORD: generateSecret(32),
      SECRET_ENCRYPTION_KEY: generateSecret(32),
      WORKER_INTERNAL_TOKEN: generateWorkerToken(),
      INITIAL_ADMIN_BOOTSTRAP_SECRET: generateSecret(24),
      ...overrides,
    }
  }

  it('generates high-entropy secrets', () => {
    const a = generateSecret(32)
    const b = generateSecret(32)
    expect(a).toHaveLength(64)
    expect(b).toHaveLength(64)
    expect(a).not.toBe(b)
    expect(generateWorkerToken().startsWith('wk_')).toBe(true)
  })

  it('rejects known insecure defaults including former compose values', () => {
    for (const bad of KNOWN_INSECURE_SECRETS) {
      expect(isInsecureSecret(bad, 8)).toBe(true)
    }
    expect(isInsecureSecret('changeme', 8)).toBe(true)
    expect(isInsecureSecret('short', 16)).toBe(true)
    expect(isInsecureSecret(generateSecret(32), SECRET_MIN_LENGTHS.NUXT_SESSION_PASSWORD)).toBe(false)
  })

  it('validateRequiredSecrets reports missing and insecure without values', () => {
    const formerEncryptionKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'
    const issues = validateRequiredSecrets({
      DATABASE_URL: '',
      NUXT_SESSION_PASSWORD: 'changeme',
      SECRET_ENCRYPTION_KEY: formerEncryptionKey,
      WORKER_INTERNAL_TOKEN: '',
    })
    expect(issues.some((i) => i.name.includes('DATABASE_URL') && i.reason === 'missing')).toBe(true)
    expect(issues.some((i) => i.name.includes('NUXT_SESSION_PASSWORD') && i.reason === 'insecure')).toBe(true)
    expect(issues.some((i) => i.name === 'WORKER_INTERNAL_TOKEN' && i.reason === 'missing')).toBe(true)
    const msg = formatSecretIssues(issues)
    expect(msg).toContain('missing')
    expect(msg).toContain('insecure')
    // Never echo configured secret material (guidance text may mention insecure examples).
    expect(msg).not.toContain(formerEncryptionKey)
    expect(msg).not.toContain('NUXT_SESSION_PASSWORD=')
  })

  it('accepts a complete strong env', () => {
    expect(validateRequiredSecrets(strongEnv())).toEqual([])
  })

  it('loads persisted secrets into empty env and persists back', async () => {
    const dir = await tempDir()
    const filePath = join(dir, APP_SECRETS_FILENAME)
    const env = strongEnv()
    const persisted = await persistSecretsFromEnv(env, filePath)
    expect(persisted.persisted).toBe(true)

    const raw = await readFile(filePath, 'utf8')
    expect(raw).toContain('DATABASE_URL=')
    expect(raw).not.toContain('changeme')

    const empty: NodeJS.ProcessEnv = {}
    const loaded = await loadPersistedSecretsIntoEnv(empty, filePath)
    expect(loaded.loaded).toBe(true)
    expect(loaded.filled).toContain('DATABASE_URL')
    expect(empty.DATABASE_URL).toBe(env.DATABASE_URL)
    expect(empty.SECRET_ENCRYPTION_KEY).toBe(env.SECRET_ENCRYPTION_KEY)
    expect(validateRequiredSecrets(empty)).toEqual([])
  })

  it('prefers non-empty env over disk (rotation)', async () => {
    const dir = await tempDir()
    const filePath = join(dir, APP_SECRETS_FILENAME)
    await persistSecretsFromEnv(strongEnv(), filePath)

    const rotated = generateSecret(32)
    const env: NodeJS.ProcessEnv = {
      NUXT_SESSION_PASSWORD: rotated,
    }
    await loadPersistedSecretsIntoEnv(env, filePath)
    expect(env.NUXT_SESSION_PASSWORD).toBe(rotated)
    expect(env.DATABASE_URL).toBeTruthy()
  })

  it('ensureAppSecrets fills from disk when host env removed', async () => {
    const dir = await tempDir()
    const filePath = join(dir, APP_SECRETS_FILENAME)
    await persistSecretsFromEnv(strongEnv(), filePath)

    const env: NodeJS.ProcessEnv = {}
    const result = await ensureAppSecrets(env, { filePath })
    expect(result.ok).toBe(true)
    expect(result.filledFromDisk.length).toBeGreaterThan(0)
    expect(result.message).not.toMatch(/[a-f0-9]{32}/i)
  })

  it('ensureAppSecrets fails closed on insecure bootstrap when set', async () => {
    const dir = await tempDir()
    const filePath = join(dir, APP_SECRETS_FILENAME)
    const env = strongEnv({ INITIAL_ADMIN_BOOTSTRAP_SECRET: 'changeme' })
    const result = await ensureAppSecrets(env, { filePath })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.name === 'INITIAL_ADMIN_BOOTSTRAP_SECRET')).toBe(true)
  })

  it('shouldFailOnSecretIssues is strict in production', () => {
    expect(shouldFailOnSecretIssues({ NODE_ENV: 'production' })).toBe(true)
    expect(shouldFailOnSecretIssues({ AI_WORKER_ALLOW_INSECURE_SECRETS: '1', NODE_ENV: 'production' })).toBe(false)
    expect(shouldFailOnSecretIssues({})).toBe(false)
    expect(shouldFailOnSecretIssues({ DATABASE_URL: 'x' })).toBe(true)
  })

  it('ignores malformed lines when reading env file', async () => {
    const dir = await tempDir()
    const filePath = join(dir, APP_SECRETS_FILENAME)
    const good = strongEnv()
    await writeFile(
      filePath,
      [
        '# comment',
        '',
        'NOT_A_SECRET=1',
        `DATABASE_URL='${good.DATABASE_URL}'`,
        `NUXT_SESSION_PASSWORD='${good.NUXT_SESSION_PASSWORD}'`,
        `SECRET_ENCRYPTION_KEY='${good.SECRET_ENCRYPTION_KEY}'`,
        `WORKER_INTERNAL_TOKEN='${good.WORKER_INTERNAL_TOKEN}'`,
      ].join('\n'),
      'utf8',
    )
    const env: NodeJS.ProcessEnv = {}
    await loadPersistedSecretsIntoEnv(env, filePath)
    expect(validateRequiredSecrets(env)).toEqual([])
  })
})
