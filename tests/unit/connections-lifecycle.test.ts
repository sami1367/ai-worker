import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/audit', () => ({
  writeAudit: vi.fn(async () => undefined),
}))

vi.mock('../../server/services/forge-credentials', () => ({
  exportForgeCredentialsAndWake: vi.fn(async () => undefined),
}))

vi.mock('../../server/services/config-sync', () => ({
  exportWorkerConfig: vi.fn(async () => undefined),
}))

vi.mock('../../server/services/forge-github', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/forge-github')>(
    '../../server/services/forge-github',
  )
  return {
    ...actual,
    revokeGitHubToken: vi.fn(async () => undefined),
  }
})

vi.mock('../../server/services/forge-gitlab', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/forge-gitlab')>(
    '../../server/services/forge-gitlab',
  )
  return {
    ...actual,
    revokeGitLabToken: vi.fn(async () => undefined),
  }
})

vi.mock('../../server/utils/crypto', () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad cipher')
    return v.slice(4)
  },
}))

import { getDb } from '../../server/utils/db'
import { writeAudit } from '../../server/services/audit'
import { exportForgeCredentialsAndWake } from '../../server/services/forge-credentials'
import { exportWorkerConfig } from '../../server/services/config-sync'
import { revokeGitHubToken } from '../../server/services/forge-github'
import {
  disconnectConnection,
  enableConnection,
  isConnectionPaused,
  listPausedConnectionIds,
  publicConnection,
  removeConnection,
  shouldExposeRepositoryForConnection,
} from '../../server/services/connections'
import { AppError } from '../../server/utils/errors'
import { revokeGitLabToken } from '../../server/services/forge-gitlab'

function baseRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2024-01-01T00:00:00Z')
  return {
    id: '11111111-1111-1111-1111-111111111111',
    provider: 'github' as const,
    displayName: 'Personal GitHub',
    instanceUrl: 'https://github.com',
    accountId: '42',
    accountLogin: 'octocat',
    accountName: 'Octo Cat',
    scopes: 'personal_access_token classic repo',
    accessTokenCiphertext: 'enc:ghp_testtoken',
    refreshTokenCiphertext: null,
    webhookSecretCiphertext: null,
    tokenExpiresAt: null,
    status: 'active' as const,
    lastError: null,
    lastSyncAt: null,
    lastValidatedAt: now,
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function mockDbSelectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
      orderBy: vi.fn().mockResolvedValue(rows),
    }),
  }
}

describe('connection pause helpers', () => {
  it('treats disconnected as paused', () => {
    expect(isConnectionPaused('disconnected')).toBe(true)
    expect(isConnectionPaused('active')).toBe(false)
    expect(isConnectionPaused('error')).toBe(false)
  })

  it('exposes repos without a connection or with a non-paused connection', () => {
    const paused = new Set(['conn-a'])
    expect(shouldExposeRepositoryForConnection(null, paused)).toBe(true)
    expect(shouldExposeRepositoryForConnection(undefined, paused)).toBe(true)
    expect(shouldExposeRepositoryForConnection('conn-b', paused)).toBe(true)
    expect(shouldExposeRepositoryForConnection('conn-a', paused)).toBe(false)
  })

  it('marks publicConnection.disabled when status is disconnected', () => {
    process.env.APP_BASE_URL = 'http://localhost:8080'
    const active = publicConnection(baseRow())
    expect(active.disabled).toBe(false)
    expect(active.status).toBe('active')

    const paused = publicConnection(baseRow({ status: 'disconnected' }))
    expect(paused.disabled).toBe(true)
    expect(paused.hasAccessToken).toBe(true)
  })
})

describe('disable / enable / remove connection', () => {
  const actor = { id: 'user-1', username: 'admin' }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SECRET_ENCRYPTION_KEY = 'test-encryption-key-32chars!!!!!!'
    process.env.APP_BASE_URL = 'http://localhost:8080'
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('disables without clearing credentials and re-exports worker config', async () => {
    const row = baseRow()
    const updated = { ...row, status: 'disconnected' as const }
    const updateReturning = vi.fn().mockResolvedValue([updated])
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([row])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: updateReturning,
          }),
        }),
      }),
    } as never)

    const result = await disconnectConnection(row.id, actor)
    expect(result.status).toBe('disconnected')
    expect(result.disabled).toBe(true)
    expect(result.hasAccessToken).toBe(true)
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection.disable' }))
    expect(exportForgeCredentialsAndWake).toHaveBeenCalledWith('forge.disable')
    expect(exportWorkerConfig).toHaveBeenCalled()
  })

  it('enable is a no-op when already active', async () => {
    const row = baseRow({ status: 'active' })
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([row])),
    } as never)

    const result = await enableConnection(row.id, actor)
    expect(result.status).toBe('active')
    expect(exportForgeCredentialsAndWake).not.toHaveBeenCalled()
  })

  it('re-enables a disabled connection that still has credentials', async () => {
    const row = baseRow({ status: 'disconnected' })
    const updated = { ...row, status: 'active' as const }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([row])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      }),
    } as never)

    const result = await enableConnection(row.id, actor)
    expect(result.status).toBe('active')
    expect(result.disabled).toBe(false)
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection.enable' }))
    expect(exportForgeCredentialsAndWake).toHaveBeenCalledWith('forge.enable')
  })

  it('refuses to enable when credentials were cleared', async () => {
    const row = baseRow({ status: 'disconnected', accessTokenCiphertext: null })
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([row])),
    } as never)

    await expect(enableConnection(row.id, actor)).rejects.toBeInstanceOf(AppError)
    await expect(enableConnection(row.id, actor)).rejects.toMatchObject({ code: 'missing_credentials' })
  })

  it('removes connection data and linked repositories', async () => {
    const row = baseRow({
      scopes: 'repo read:user',
      accessTokenCiphertext: 'enc:oauth-token',
    })
    const linkedRepo = {
      id: 'repo-1',
      connectionId: row.id,
      workspaceId: 'abcd1234efgh5678',
      localPath: null,
    }

    const deleteWhere = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn()
        .mockReturnValueOnce(mockDbSelectReturning([row]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([linkedRepo]),
          }),
        }),
      delete: vi.fn().mockReturnValue({
        where: deleteWhere,
      }),
    } as never)

    const result = await removeConnection(row.id, actor)
    expect(result).toEqual({ ok: true, id: row.id, removedRepositories: 1 })
    expect(revokeGitHubToken).toHaveBeenCalledWith('oauth-token')
    expect(deleteWhere).toHaveBeenCalledTimes(2)
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection.remove' }))
    expect(exportForgeCredentialsAndWake).toHaveBeenCalledWith('forge.remove')
    expect(exportWorkerConfig).toHaveBeenCalled()
  })

  it('disable is idempotent when already disconnected', async () => {
    const row = baseRow({ status: 'disconnected' })
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([row])),
    } as never)

    const result = await disconnectConnection(row.id, actor)
    expect(result.status).toBe('disconnected')
    expect(exportForgeCredentialsAndWake).not.toHaveBeenCalled()
  })

  it('lists paused connection ids', async () => {
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'paused-1' },
            { id: 'paused-2' },
          ]),
        }),
      }),
    } as never)

    await expect(listPausedConnectionIds()).resolves.toEqual(['paused-1', 'paused-2'])
  })

  it('swallows exportWorkerConfig failures on disable and enable', async () => {
    vi.mocked(exportWorkerConfig).mockRejectedValueOnce(new Error('export failed'))
    const row = baseRow()
    const updated = { ...row, status: 'disconnected' as const }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([row])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      }),
    } as never)
    await expect(disconnectConnection(row.id, actor)).resolves.toMatchObject({ status: 'disconnected' })

    vi.mocked(exportWorkerConfig).mockRejectedValueOnce(new Error('export failed'))
    const disabled = baseRow({ status: 'disconnected' })
    const reenabled = { ...disabled, status: 'active' as const }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue(mockDbSelectReturning([disabled])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reenabled]),
          }),
        }),
      }),
    } as never)
    await expect(enableConnection(disabled.id, actor)).resolves.toMatchObject({ status: 'active' })
  })

  it('removes a GitLab OAuth connection and tolerates decrypt/workspace failures', async () => {
    const row = baseRow({
      provider: 'gitlab',
      instanceUrl: 'https://gitlab.example',
      scopes: 'api read_user',
      accessTokenCiphertext: 'not-enc-prefix',
    })
    const linkedRepo = {
      id: 'repo-2',
      connectionId: row.id,
      workspaceId: '!!!invalid!!!',
      localPath: '/elsewhere',
    }
    const deleteWhere = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn()
        .mockReturnValueOnce(mockDbSelectReturning([row]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([linkedRepo]),
          }),
        }),
      delete: vi.fn().mockReturnValue({ where: deleteWhere }),
    } as never)
    vi.mocked(exportWorkerConfig).mockRejectedValueOnce(new Error('export failed'))

    const result = await removeConnection(row.id, actor)
    expect(result.removedRepositories).toBe(1)
    expect(revokeGitLabToken).not.toHaveBeenCalled()
    expect(revokeGitHubToken).not.toHaveBeenCalled()
  })

  it('revokes GitLab OAuth token on remove when decrypt succeeds', async () => {
    const row = baseRow({
      provider: 'gitlab',
      instanceUrl: 'https://gitlab.example',
      scopes: 'api read_user',
      accessTokenCiphertext: 'enc:gl-oauth',
    })
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn()
        .mockReturnValueOnce(mockDbSelectReturning([row]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as never)

    await removeConnection(row.id, actor)
    expect(revokeGitLabToken).toHaveBeenCalledWith('https://gitlab.example', 'gl-oauth')
  })
})
