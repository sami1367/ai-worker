import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/audit', () => ({
  writeAudit: vi.fn(async () => undefined),
}))

vi.mock('../../server/services/provider-credentials', () => ({
  exportProviderCredentialsForWorker: vi.fn(async () => undefined),
}))

vi.mock('../../server/services/settings', () => ({
  getSettings: vi.fn(async () => ({ defaultAiProvider: 'cursor' })),
  updateSettings: vi.fn(async () => undefined),
}))

vi.mock('../../server/utils/crypto', () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad cipher')
    return v.slice(4)
  },
}))

vi.mock('../../server/services/worker-runtime', () => ({
  applyWorkerRuntimeChange: vi.fn(async () => undefined),
  exportWorkerRuntimeEnv: vi.fn(async () => undefined),
}))

import { getDb } from '../../server/utils/db'
import { writeAudit } from '../../server/services/audit'
import { exportProviderCredentialsForWorker } from '../../server/services/provider-credentials'
import { applyWorkerRuntimeChange } from '../../server/services/worker-runtime'
import { publicProvider, updateProvider } from '../../server/services/providers'

const PLAIN_SECRET = 'sk-test-provider-secret-value-never-expose'
const STORED_CIPHER = `enc:${PLAIN_SECRET}`

function baseRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2024-01-01T00:00:00Z')
  return {
    id: '22222222-2222-2222-2222-222222222222',
    providerType: 'cursor',
    displayName: 'Cursor CLI',
    isEnabled: true,
    isDefault: true,
    config: {},
    secretCiphertext: STORED_CIPHER,
    lastHealthCheckAt: null,
    healthStatus: 'unknown',
    healthMessage: null,
    detectedVersion: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function assertNoSecretMaterial(payload: Record<string, unknown>) {
  const serialized = JSON.stringify(payload)
  expect(serialized).not.toContain(PLAIN_SECRET)
  expect(serialized).not.toContain(STORED_CIPHER)
  expect(serialized).not.toContain('secretCiphertext')
  expect(payload).not.toHaveProperty('secret')
  expect(payload).not.toHaveProperty('secretCiphertext')
  expect(payload).not.toHaveProperty('apiKey')
  expect(payload).not.toHaveProperty('token')
}

describe('publicProvider secret policy', () => {
  afterEach(() => {
    delete process.env.CURSOR_API_KEY
  })

  it('never returns stored or env secret material — only presence flags', () => {
    process.env.CURSOR_API_KEY = 'env-should-not-appear'
    const pub = publicProvider(baseRow())
    assertNoSecretMaterial(pub as unknown as Record<string, unknown>)
    expect(pub.hasSecret).toBe(true)
    expect(pub.hasStoredSecret).toBe(true)
    expect(pub.secretSource).toBe('stored')
    expect(JSON.stringify(pub)).not.toContain('env-should-not-appear')
  })

  it('reports env-only connection without exposing the env value', () => {
    process.env.CURSOR_API_KEY = 'env-only-secret'
    const pub = publicProvider(baseRow({ secretCiphertext: null }))
    assertNoSecretMaterial(pub as unknown as Record<string, unknown>)
    expect(pub.hasSecret).toBe(true)
    expect(pub.hasStoredSecret).toBe(false)
    expect(pub.secretSource).toBe('env')
    expect(JSON.stringify(pub)).not.toContain('env-only-secret')
  })
})

describe('updateProvider secret retention', () => {
  const actor = { id: 'user-1', username: 'admin' }
  const encryptionKey = 'test-encryption-key-32chars!!!!!!'

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CURSOR_API_KEY
  })

  afterEach(() => {
    vi.resetAllMocks()
    delete process.env.CURSOR_API_KEY
  })

  function mockUpdateProviderDb(existing: ReturnType<typeof baseRow>) {
    const rows = [existing]
    const setMock = vi.fn()
    const returning = vi.fn().mockImplementation(async () => {
      const patch = setMock.mock.calls[setMock.mock.calls.length - 1]?.[0] || {}
      const merged = { ...existing, ...patch }
      Object.assign(existing, merged)
      return [merged]
    })
    setMock.mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
      returning,
    })

    const updateMock = vi.fn().mockReturnValue({ set: setMock })

    // ensureProviderRows: insert().values().onConflictDoNothing() ×5
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    })

    // Supports both `.from().where().limit()` and bare `.from()` (list all).
    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => {
        const fromResult = Object.assign(Promise.resolve(rows), {
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        })
        return fromResult
      }),
    }))

    vi.mocked(getDb).mockReturnValue({
      select: selectMock,
      insert: insertMock,
      update: updateMock,
    } as never)

    return { setMock, updateMock }
  }

  it('retains existing ciphertext when secret is omitted', async () => {
    const existing = baseRow()
    const { setMock } = mockUpdateProviderDb(existing)

    const result = await updateProvider('cursor', { isEnabled: true }, actor, encryptionKey)

    expect(setMock).toHaveBeenCalled()
    const lastSet = setMock.mock.calls.find((c) => c[0]?.secretCiphertext !== undefined)?.[0]
    expect(lastSet?.secretCiphertext).toBe(STORED_CIPHER)
    expect(exportProviderCredentialsForWorker).not.toHaveBeenCalled()
    assertNoSecretMaterial(result as unknown as Record<string, unknown>)
    expect(result.hasStoredSecret).toBe(true)
  })

  it('retains existing ciphertext when secret is blank or whitespace', async () => {
    const existing = baseRow()

    for (const blank of ['', '   ', '\t']) {
      vi.clearAllMocks()
      const { setMock } = mockUpdateProviderDb(existing)
      await updateProvider('cursor', { secret: blank }, actor, encryptionKey)
      const lastSet = setMock.mock.calls.find((c) => c[0]?.secretCiphertext !== undefined)?.[0]
      expect(lastSet?.secretCiphertext).toBe(STORED_CIPHER)
      expect(exportProviderCredentialsForWorker).not.toHaveBeenCalled()
    }
  })

  it('updates ciphertext only when a non-blank secret is provided', async () => {
    const existing = baseRow()
    const { setMock } = mockUpdateProviderDb(existing)
    const next = 'sk-new-replacement-secret'

    const result = await updateProvider('cursor', { secret: `  ${next}  ` }, actor, encryptionKey)

    const lastSet = setMock.mock.calls.find((c) => c[0]?.secretCiphertext !== undefined)?.[0]
    expect(lastSet?.secretCiphertext).toBe(`enc:${next}`)
    expect(exportProviderCredentialsForWorker).toHaveBeenCalledOnce()
    assertNoSecretMaterial(result as unknown as Record<string, unknown>)
    expect(JSON.stringify(result)).not.toContain(next)
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ secretChanged: true }),
    }))
  })

  it('clears stored secret when secret is explicitly null', async () => {
    const existing = baseRow()
    const { setMock } = mockUpdateProviderDb(existing)

    const result = await updateProvider('cursor', { secret: null }, actor, encryptionKey)

    const lastSet = setMock.mock.calls.find((c) => 'secretCiphertext' in (c[0] || {}))?.[0]
    expect(lastSet?.secretCiphertext).toBeNull()
    expect(exportProviderCredentialsForWorker).toHaveBeenCalledOnce()
    assertNoSecretMaterial(result as unknown as Record<string, unknown>)
  })

  it('rejects a new secret when encryption key is missing', async () => {
    const existing = baseRow()
    mockUpdateProviderDb(existing)
    await expect(updateProvider('cursor', { secret: 'sk-new' }, actor, ''))
      .rejects.toMatchObject({ statusCode: 500, code: 'misconfigured' })
    expect(exportProviderCredentialsForWorker).not.toHaveBeenCalled()
  })

  it('records secretChanged false in audit when blank secret retains existing value', async () => {
    const existing = baseRow()
    mockUpdateProviderDb(existing)
    await updateProvider('cursor', { secret: '' }, actor, encryptionKey)
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ secretChanged: false }),
    }))
  })

  it('continues when credential export or worker wake fails after a secret change', async () => {
    const existing = baseRow()
    mockUpdateProviderDb(existing)
    vi.mocked(exportProviderCredentialsForWorker).mockRejectedValueOnce(new Error('export failed'))
    vi.mocked(applyWorkerRuntimeChange).mockRejectedValueOnce(new Error('wake failed'))

    const result = await updateProvider('cursor', { secret: 'sk-after-errors' }, actor, encryptionKey)

    expect(result.hasStoredSecret).toBe(true)
    assertNoSecretMaterial(result as unknown as Record<string, unknown>)
    expect(writeAudit).toHaveBeenCalled()
  })
})
