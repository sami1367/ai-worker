import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  getSettings: vi.fn(async () => ({
    defaultAiProvider: 'cursor',
    pollIntervalSeconds: 30,
    configVersion: 7,
  })),
  updateSettings: vi.fn(async () => undefined),
}))

vi.mock('../../server/utils/crypto', () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad cipher')
    return v.slice(4)
  },
}))

vi.mock('../../server/services/webhooks', () => ({
  wakeWorkerPoll: vi.fn(async () => undefined),
}))

vi.mock('../../server/utils/paths', () => ({
  workerBaseDir: vi.fn(),
}))

vi.mock('../../server/services/worker-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/services/worker-runtime')>()
  return {
    ...actual,
    applyWorkerRuntimeChange: vi.fn(async () => undefined),
  }
})

import { getDb } from '../../server/utils/db'
import { writeAudit } from '../../server/services/audit'
import {
  applyWorkerRuntimeChange,
  exportWorkerRuntimeEnv,
} from '../../server/services/worker-runtime'
import { workerBaseDir } from '../../server/utils/paths'
import {
  mergeProviderConfig,
  normalizeProviderModel,
  PROVIDER_MODEL_ENV_VARS,
  providerModelFromConfig,
  updateProvider,
} from '../../server/services/providers'

describe('provider model helpers', () => {
  it('normalizes model strings and rejects non-strings', () => {
    expect(normalizeProviderModel('  sonnet  ')).toBe('sonnet')
    expect(normalizeProviderModel('')).toBe('')
    expect(normalizeProviderModel('   ')).toBe('')
    expect(normalizeProviderModel(null)).toBe('')
    expect(normalizeProviderModel(12)).toBe('')
    expect(normalizeProviderModel('x'.repeat(200))).toHaveLength(128)
  })

  it('reads model from provider config', () => {
    expect(providerModelFromConfig({ model: ' opus ' })).toBe('opus')
    expect(providerModelFromConfig({})).toBe('')
    expect(providerModelFromConfig(undefined)).toBe('')
  })

  it('merges config and omits empty model so CLI default applies', () => {
    expect(mergeProviderConfig({ credentialType: 'anthropic_api_key' }, { model: 'sonnet' }))
      .toEqual({ credentialType: 'anthropic_api_key', model: 'sonnet' })
    expect(mergeProviderConfig({ model: 'sonnet' }, { model: '' }))
      .toEqual({})
    expect(mergeProviderConfig({ model: 'sonnet', credentialType: 'anthropic_api_key' }, { model: '  ' }))
      .toEqual({ credentialType: 'anthropic_api_key' })
  })

  it('maps each known provider to a worker model env var', () => {
    expect(PROVIDER_MODEL_ENV_VARS).toEqual({
      cursor: 'AI_CURSOR_MODEL',
      claude: 'AI_CLAUDE_MODEL',
      codex: 'AI_CODEX_MODEL',
      gemini: 'AI_GEMINI_MODEL',
      copilot: 'AI_COPILOT_MODEL',
    })
  })
})

describe('updateProvider persists model and wakes worker', () => {
  const actor = { id: 'user-1', username: 'admin' }
  const encryptionKey = 'test-encryption-key-32chars!!!!!!'

  function baseRow(overrides: Record<string, unknown> = {}) {
    const now = new Date('2024-01-01T00:00:00Z')
    return {
      id: '22222222-2222-2222-2222-222222222222',
      providerType: 'claude',
      displayName: 'Claude Code CLI',
      isEnabled: true,
      isDefault: true,
      config: { credentialType: 'anthropic_api_key' },
      secretCiphertext: 'enc:sk-test',
      lastHealthCheckAt: null,
      healthStatus: 'unknown',
      healthMessage: null,
      detectedVersion: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

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
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    })
    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => {
        return Object.assign(Promise.resolve(rows), {
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        })
      }),
    }))

    vi.mocked(getDb).mockReturnValue({
      select: selectMock,
      insert: insertMock,
      update: updateMock,
    } as never)

    return { setMock }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('stores trimmed model in config and wakes worker runtime on config-only save', async () => {
    const existing = baseRow()
    const { setMock } = mockUpdateProviderDb(existing)

    const result = await updateProvider(
      'claude',
      { config: { credentialType: 'anthropic_api_key', model: '  sonnet  ' } },
      actor,
      encryptionKey,
    )

    const lastSet = setMock.mock.calls.find((c) => c[0]?.config !== undefined)?.[0]
    expect(lastSet?.config).toEqual({ credentialType: 'anthropic_api_key', model: 'sonnet' })
    expect(result.config).toEqual({ credentialType: 'anthropic_api_key', model: 'sonnet' })
    expect(applyWorkerRuntimeChange).toHaveBeenCalledWith(
      'provider.update',
      expect.objectContaining({ configChanged: true, model: 'sonnet' }),
    )
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ model: 'sonnet', secretChanged: false }),
    }))
  })

  it('clears model from config when empty so CLI default is used', async () => {
    const existing = baseRow({ config: { credentialType: 'anthropic_api_key', model: 'opus' } })
    const { setMock } = mockUpdateProviderDb(existing)

    await updateProvider(
      'claude',
      { config: { credentialType: 'anthropic_api_key', model: '' } },
      actor,
      encryptionKey,
    )

    const lastSet = setMock.mock.calls.find((c) => c[0]?.config !== undefined)?.[0]
    expect(lastSet?.config).toEqual({ credentialType: 'anthropic_api_key' })
    expect(applyWorkerRuntimeChange).toHaveBeenCalledWith(
      'provider.update',
      expect.objectContaining({ configChanged: true, model: '' }),
    )
  })

  it('continues when worker runtime wake fails after a model config save', async () => {
    const existing = baseRow()
    mockUpdateProviderDb(existing)
    vi.mocked(applyWorkerRuntimeChange).mockRejectedValueOnce(new Error('wake failed'))

    const result = await updateProvider(
      'claude',
      { config: { model: 'haiku' } },
      actor,
      encryptionKey,
    )

    expect(result.config).toEqual({ credentialType: 'anthropic_api_key', model: 'haiku' })
    expect(writeAudit).toHaveBeenCalled()
  })
})

describe('exportWorkerRuntimeEnv model overrides', () => {
  let dir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'aiw-runtime-model-'))
    vi.mocked(workerBaseDir).mockReturnValue(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('exports selected models and empty strings for CLI defaults', async () => {
    const rows = [
      { providerType: 'cursor', isDefault: true, config: { model: 'composer-1' } },
      { providerType: 'claude', isDefault: false, config: { model: 'sonnet' } },
      { providerType: 'codex', isDefault: false, config: {} },
      { providerType: 'gemini', isDefault: false, config: { model: '  gemini-2.5-pro  ' } },
      { providerType: 'copilot', isDefault: false, config: { model: '' } },
    ]

    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(rows),
      }),
    } as never)

    const result = await exportWorkerRuntimeEnv()
    const body = await readFile(result.path, 'utf8')

    expect(result.models).toEqual({
      cursor: 'composer-1',
      claude: 'sonnet',
      codex: '',
      gemini: 'gemini-2.5-pro',
      copilot: '',
    })
    expect(body).toContain("export AI_PROVIDER='cursor'")
    expect(body).toContain("export AI_CURSOR_MODEL='composer-1'")
    expect(body).toContain("export AI_CLAUDE_MODEL='sonnet'")
    expect(body).toContain("export AI_CODEX_MODEL=''")
    expect(body).toContain("export AI_GEMINI_MODEL='gemini-2.5-pro'")
    expect(body).toContain("export AI_COPILOT_MODEL=''")
  })

  it('exports empty model lines for every provider when none are configured', async () => {
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([
          { providerType: 'cursor', isDefault: false, config: {} },
        ]),
      }),
    } as never)

    const result = await exportWorkerRuntimeEnv()
    const body = await readFile(result.path, 'utf8')
    expect(result.aiProvider).toBe('cursor')
    expect(result.models.cursor).toBe('')
    expect(body).toContain("export AI_CURSOR_MODEL=''")
    expect(body).toContain("export AI_CLAUDE_MODEL=''")
  })

  it('shell-quotes model values that contain single quotes', async () => {
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([
          { providerType: 'cursor', isDefault: true, config: { model: "o'custom" } },
        ]),
      }),
    } as never)

    const result = await exportWorkerRuntimeEnv()
    const body = await readFile(result.path, 'utf8')
    expect(result.models.cursor).toBe("o'custom")
    expect(body).toContain("export AI_CURSOR_MODEL='o'\\''custom'")
  })
})

describe('providers page model selection UI', () => {
  it('offers a model select with default CLI option and persists draft.model', () => {
    const source = readFileSync(resolve(__dirname, '../../app/pages/providers.vue'), 'utf8')
    expect(source).toMatch(/model:\s*''/)
    expect(source).toMatch(/PROVIDER_MODEL_OPTIONS/)
    expect(source).toMatch(/label="Model"/)
    expect(source).toMatch(/v-model="draftFor\(p\.providerType\)\.model"/)
    expect(source).toMatch(/Default \(CLI\)/)
    expect(source).toMatch(/model:\s*d\.model\.trim\(\)/)
    expect(source).toMatch(/d\.model\s*=\s*model/)
  })
})
