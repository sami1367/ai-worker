import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/connections', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/connections')>(
    '../../server/services/connections',
  )
  return {
    ...actual,
    ensureConnectionAccount: vi.fn(),
    listPausedConnectionIds: vi.fn(async () => []),
  }
})

vi.mock('../../server/services/queue-events', () => ({
  publishQueueUpdated: vi.fn(),
}))

vi.mock('../../server/services/forge-github', () => ({
  listGitHubAiIssues: vi.fn(),
  listGitHubAiPullRequests: vi.fn(async () => []),
}))

vi.mock('../../server/services/forge-gitlab', () => ({
  listGitLabAiIssues: vi.fn(),
  listGitLabAiMergeRequests: vi.fn(async () => []),
}))

import { getDb } from '../../server/utils/db'
import { ensureConnectionAccount } from '../../server/services/connections'
import { listGitHubAiIssues } from '../../server/services/forge-github'
import { listGitLabAiIssues } from '../../server/services/forge-gitlab'
import { syncRepositoryQueue } from '../../server/services/task-queue'

describe('syncRepositoryQueue assignee filter', () => {
  const inserted: unknown[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    inserted.length = 0
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: unknown) => {
          inserted.push(vals)
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as never)
  })

  it('persists only GitHub issues assigned to the connected account', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: {
        id: 'c1',
        accountId: '28010102',
        accountLogin: 'sami1367',
        instanceUrl: 'https://github.com',
      },
    } as never)
    vi.mocked(listGitHubAiIssues).mockResolvedValue([
      {
        externalId: '36',
        title: 'mine',
        url: 'https://github.com/acme/app/issues/36',
        labels: ['ai'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '28010102', login: 'sami1367' }],
      },
      {
        externalId: '37',
        title: 'other',
        url: 'https://github.com/acme/app/issues/37',
        labels: ['ai'],
        createdAt: '2026-01-03T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '9', login: 'someone-else' }],
      },
      {
        externalId: '38',
        title: 'unassigned',
        url: 'https://github.com/acme/app/issues/38',
        labels: ['ai'],
        createdAt: '2026-01-04T00:00:00Z',
        kind: 'issue',
        assignees: [],
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'acme/app',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'acme/app',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)

    expect(result).toEqual({ ok: true, itemCount: 1 })
    const issueInsert = inserted.find((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'issue',
    ) as { externalId: string, assignees: Array<{ login: string }> }
    expect(issueInsert.externalId).toBe('36')
    expect(issueInsert.assignees).toEqual([{ id: '28010102', login: 'sami1367' }])
  })

  it('persists only GitLab issues assigned to the connected account', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: {
        id: 'c2',
        accountId: '42',
        accountLogin: 'samirahimi',
        instanceUrl: 'https://gitlab.example',
      },
    } as never)
    vi.mocked(listGitLabAiIssues).mockResolvedValue([
      {
        externalId: '1',
        title: 'mine',
        url: 'https://gitlab.example/g/p/-/issues/1',
        labels: ['ai'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '42', login: 'samirahimi' }],
      },
      {
        externalId: '2',
        title: 'other',
        url: 'https://gitlab.example/g/p/-/issues/2',
        labels: ['ai'],
        createdAt: '2026-01-03T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '99', login: 'other' }],
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r2',
      name: 'g/p',
      forgeType: 'gitlab',
      connectionId: 'c2',
      canonicalProjectIdentifier: 'g/p',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: 'https://gitlab.example',
    } as never)

    expect(result).toEqual({ ok: true, itemCount: 1 })
    const issueInsert = inserted.find((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'issue',
    ) as { externalId: string, assignees: Array<{ login: string }> }
    expect(issueInsert.externalId).toBe('1')
    expect(issueInsert.assignees[0].login).toBe('samirahimi')
  })
})
