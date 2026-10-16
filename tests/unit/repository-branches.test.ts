import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/connections', () => ({
  getConnectionAccessToken: vi.fn(),
  listPausedConnectionIds: vi.fn(async () => []),
}))

vi.mock('../../server/services/forge-github', () => ({
  listGitHubBranches: vi.fn(),
}))

vi.mock('../../server/services/forge-gitlab', () => ({
  listGitLabBranches: vi.fn(),
}))

import { getDb } from '../../server/utils/db'
import { getConnectionAccessToken } from '../../server/services/connections'
import { listGitHubBranches } from '../../server/services/forge-github'
import { listGitLabBranches } from '../../server/services/forge-gitlab'
import { listRepositoryBranches } from '../../server/services/repositories'
import { AppError } from '../../server/utils/errors'

function mockRepoRow(overrides: Record<string, unknown> = {}) {
  return {
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
    settings: {},
    isArchived: false,
    workspaceId: 'w1',
    localPath: '/tmp/w1',
    isEnabled: true,
    connectionId: 'c1',
    discoveredRepositoryId: null,
    providerRepoId: '99',
    instanceUrl: 'https://github.com',
    visibility: 'private',
    workspaceStatus: 'ready',
    lastSyncAt: null,
    lastCloneAt: null,
    lastError: null,
    lastHealthCheckAt: null,
    healthStatus: 'unknown',
    healthMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function mockSelect(row: unknown | null) {
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        }),
      }),
    }),
  } as never)
}

describe('listRepositoryBranches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists GitHub branches and keeps current default first when missing remotely', async () => {
    mockSelect(mockRepoRow({ defaultBranch: 'release' }))
    vi.mocked(getConnectionAccessToken).mockResolvedValue({
      token: 'gh-tok',
      row: { provider: 'github', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubBranches).mockResolvedValue(['main', 'develop'])

    const result = await listRepositoryBranches('r1')
    expect(listGitHubBranches).toHaveBeenCalledWith('gh-tok', 'acme/app')
    expect(listGitLabBranches).not.toHaveBeenCalled()
    expect(result.defaultBranch).toBe('release')
    expect(result.branches[0]).toBe('release')
    expect(result.branches).toEqual(['release', 'main', 'develop'])
  })

  it('lists GitLab branches using connection instance URL', async () => {
    mockSelect(mockRepoRow({
      forgeType: 'gitlab',
      canonicalProjectIdentifier: 'group/proj',
      remoteUrl: 'https://gitlab.example/group/proj.git',
      defaultBranch: 'main',
      instanceUrl: 'https://gitlab.example',
    }))
    vi.mocked(getConnectionAccessToken).mockResolvedValue({
      token: 'gl-tok',
      row: { provider: 'gitlab', instanceUrl: 'https://gitlab.example' },
    } as never)
    vi.mocked(listGitLabBranches).mockResolvedValue(['main', 'feature'])

    const result = await listRepositoryBranches('r1')
    expect(listGitLabBranches).toHaveBeenCalledWith('https://gitlab.example', 'gl-tok', 'group/proj')
    expect(result.branches).toEqual(['main', 'feature'])
  })

  it('falls back to remote URL path when canonical identifier is missing', async () => {
    mockSelect(mockRepoRow({
      canonicalProjectIdentifier: null,
      providerRepoId: '12345',
      remoteUrl: 'https://github.com/acme/from-url.git',
    }))
    vi.mocked(getConnectionAccessToken).mockResolvedValue({
      token: 'gh-tok',
      row: { provider: 'github', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubBranches).mockResolvedValue(['main'])

    await listRepositoryBranches('r1')
    expect(listGitHubBranches).toHaveBeenCalledWith('gh-tok', 'acme/from-url')
  })

  it('uses GitHub owner/name providerRepoId when present', async () => {
    mockSelect(mockRepoRow({
      canonicalProjectIdentifier: null,
      providerRepoId: 'acme/from-id',
      remoteUrl: 'https://github.com/acme/ignored.git',
    }))
    vi.mocked(getConnectionAccessToken).mockResolvedValue({
      token: 'gh-tok',
      row: { provider: 'github', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubBranches).mockResolvedValue(['main'])

    await listRepositoryBranches('r1')
    expect(listGitHubBranches).toHaveBeenCalledWith('gh-tok', 'acme/from-id')
  })

  it('treats a remote URL that strips to empty as missing project ref', async () => {
    mockSelect(mockRepoRow({
      canonicalProjectIdentifier: null,
      providerRepoId: null,
      remoteUrl: 'https://github.com/',
      connectionId: 'c1',
    }))
    await expect(listRepositoryBranches('r1')).rejects.toMatchObject({
      code: 'missing_project_ref',
    } satisfies Partial<AppError>)
  })

  it('uses GitLab numeric providerRepoId when no canonical path', async () => {
    mockSelect(mockRepoRow({
      forgeType: 'gitlab',
      canonicalProjectIdentifier: null,
      providerRepoId: '77',
      remoteUrl: 'https://gitlab.com/group/x.git',
    }))
    vi.mocked(getConnectionAccessToken).mockResolvedValue({
      token: 'gl-tok',
      row: { provider: 'gitlab', instanceUrl: 'https://gitlab.com' },
    } as never)
    vi.mocked(listGitLabBranches).mockResolvedValue(['main'])

    await listRepositoryBranches('r1')
    expect(listGitLabBranches).toHaveBeenCalledWith('https://gitlab.com', 'gl-tok', '77')
  })

  it('deduplicates branch names', async () => {
    mockSelect(mockRepoRow({ defaultBranch: 'main' }))
    vi.mocked(getConnectionAccessToken).mockResolvedValue({
      token: 'gh-tok',
      row: { provider: 'github', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubBranches).mockResolvedValue(['main', 'main', 'feat', ''])

    const result = await listRepositoryBranches('r1')
    expect(result.branches).toEqual(['main', 'feat'])
  })

  it('throws not_found for missing or archived repos', async () => {
    mockSelect(null)
    await expect(listRepositoryBranches('missing')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<AppError>)

    mockSelect(mockRepoRow({ isArchived: true }))
    await expect(listRepositoryBranches('r1')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<AppError>)
  })

  it('throws when connection or project ref is missing', async () => {
    mockSelect(mockRepoRow({ connectionId: null }))
    await expect(listRepositoryBranches('r1')).rejects.toMatchObject({
      code: 'missing_connection',
    } satisfies Partial<AppError>)

    mockSelect(mockRepoRow({
      canonicalProjectIdentifier: null,
      providerRepoId: null,
      remoteUrl: '',
      connectionId: 'c1',
    }))
    await expect(listRepositoryBranches('r1')).rejects.toMatchObject({
      code: 'missing_project_ref',
    } satisfies Partial<AppError>)
  })
})
