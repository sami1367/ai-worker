import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/audit', () => ({
  writeAudit: vi.fn(async () => undefined),
}))

vi.mock('../../server/services/config-sync', () => ({
  exportWorkerConfig: vi.fn(async () => undefined),
}))

import { getDb } from '../../server/utils/db'
import {
  acceptedReportersFromSettings,
  repositorySettingsSchema,
  updateRepository,
} from '../../server/services/repositories'

describe('acceptedReportersFromSettings', () => {
  it('returns empty for missing or non-array values', () => {
    expect(acceptedReportersFromSettings(undefined)).toEqual([])
    expect(acceptedReportersFromSettings(null)).toEqual([])
    expect(acceptedReportersFromSettings({})).toEqual([])
    expect(acceptedReportersFromSettings({ acceptedReporters: 'alice' })).toEqual([])
  })

  it('trims, drops empties, and de-duplicates case-insensitively', () => {
    expect(acceptedReportersFromSettings({
      acceptedReporters: [' Alice ', 'bob', 'alice', '', '  ', 12, null],
    })).toEqual(['Alice', 'bob'])
  })
})

describe('repositorySettingsSchema acceptedReporters', () => {
  it('accepts an empty or populated list', () => {
    expect(repositorySettingsSchema.parse({ acceptedReporters: [] })).toEqual({
      acceptedReporters: [],
    })
    expect(repositorySettingsSchema.parse({
      acceptedReporters: ['alice', 'bob'],
    }).acceptedReporters).toEqual(['alice', 'bob'])
  })

  it('rejects oversized login strings', () => {
    expect(() => repositorySettingsSchema.parse({
      acceptedReporters: ['a'.repeat(129)],
    })).toThrow()
  })
})

describe('updateRepository acceptedReporters persistence', () => {
  let lastSettings: unknown

  beforeEach(() => {
    vi.clearAllMocks()
    lastSettings = undefined
    const existing = {
      id: 'r1',
      name: 'acme/app',
      forgeType: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      canonicalProjectIdentifier: 'acme/app',
      defaultBranch: 'main',
      blockOnOpenPr: true,
      forcePushToDefault: false,
      codegraphEnabled: true,
      defaultAiProvider: 'cursor',
      settings: { customPrompt: 'keep', acceptedReporters: ['old'] },
      isArchived: false,
      workspaceId: 'w1',
      localPath: '/tmp/w1',
      isEnabled: true,
      connectionId: null,
      discoveredRepositoryId: null,
      providerRepoId: null,
      instanceUrl: null,
      visibility: null,
      workspaceStatus: 'ready',
      lastSyncAt: null,
      lastCloneAt: null,
      lastError: null,
      lastHealthCheckAt: null,
      healthStatus: 'unknown',
      healthMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existing]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: { settings?: unknown }) => {
          lastSettings = vals.settings
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...existing, ...vals, settings: vals.settings }]),
            }),
          }
        }),
      }),
    } as never)
  })

  it('normalizes and persists acceptedReporters from the patch', async () => {
    const row = await updateRepository(
      'r1',
      { settings: { acceptedReporters: [' Alice ', 'bob', 'alice'] } },
      { id: 'u1', username: 'admin' },
    )
    expect(lastSettings).toMatchObject({
      customPrompt: 'keep',
      acceptedReporters: ['Alice', 'bob'],
    })
    expect(row.settings).toMatchObject({ acceptedReporters: ['Alice', 'bob'] })
  })

  it('keeps existing acceptedReporters when the patch omits the field', async () => {
    await updateRepository(
      'r1',
      { settings: { customPrompt: 'new prompt' } },
      { id: 'u1', username: 'admin' },
    )
    expect(lastSettings).toMatchObject({
      customPrompt: 'new prompt',
      acceptedReporters: ['old'],
    })
  })
})
