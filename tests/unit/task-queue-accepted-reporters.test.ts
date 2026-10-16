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

describe('syncRepositoryQueue accepted reporters filter', () => {
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

  it('queues all assigned GitHub issues when acceptedReporters is empty', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: {
        id: 'c1',
        accountId: '28010102',
        accountLogin: 'bot',
        instanceUrl: 'https://github.com',
      },
    } as never)
    vi.mocked(listGitHubAiIssues).mockResolvedValue([
      {
        externalId: '1',
        title: 'from alice',
        url: 'https://github.com/acme/app/issues/1',
        labels: ['ai'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '28010102', login: 'bot' }],
        author: { id: '10', login: 'alice' },
      },
      {
        externalId: '2',
        title: 'from bob',
        url: 'https://github.com/acme/app/issues/2',
        labels: ['ai'],
        createdAt: '2026-01-03T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '28010102', login: 'bot' }],
        author: { id: '11', login: 'bob' },
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
      settings: { acceptedReporters: [] },
    } as never)

    expect(result).toEqual({ ok: true, itemCount: 2 })
  })

  it('queues only GitHub issues from accepted reporters when allowlist is set', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: {
        id: 'c1',
        accountId: '28010102',
        accountLogin: 'bot',
        instanceUrl: 'https://github.com',
      },
    } as never)
    vi.mocked(listGitHubAiIssues).mockResolvedValue([
      {
        externalId: '1',
        title: 'from alice',
        url: 'https://github.com/acme/app/issues/1',
        labels: ['ai'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '28010102', login: 'bot' }],
        author: { id: '10', login: 'Alice' },
      },
      {
        externalId: '2',
        title: 'from bob',
        url: 'https://github.com/acme/app/issues/2',
        labels: ['ai'],
        createdAt: '2026-01-03T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '28010102', login: 'bot' }],
        author: { id: '11', login: 'bob' },
      },
      {
        externalId: '3',
        title: 'unknown author',
        url: 'https://github.com/acme/app/issues/3',
        labels: ['ai'],
        createdAt: '2026-01-04T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '28010102', login: 'bot' }],
        author: null,
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
      settings: { acceptedReporters: ['alice'] },
    } as never)

    expect(result).toEqual({ ok: true, itemCount: 1 })
    const issueInsert = inserted.find((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'issue',
    ) as { externalId: string }
    expect(issueInsert.externalId).toBe('1')
  })

  it('queues only GitLab issues from accepted reporters when allowlist is set', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: {
        id: 'c2',
        accountId: '42',
        accountLogin: 'bot',
        instanceUrl: 'https://gitlab.example',
      },
    } as never)
    vi.mocked(listGitLabAiIssues).mockResolvedValue([
      {
        externalId: '1',
        title: 'from alice',
        url: 'https://gitlab.example/g/p/-/issues/1',
        labels: ['ai'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '42', login: 'bot' }],
        author: { id: '10', login: 'alice' },
      },
      {
        externalId: '2',
        title: 'from bob',
        url: 'https://gitlab.example/g/p/-/issues/2',
        labels: ['ai'],
        createdAt: '2026-01-03T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '42', login: 'bot' }],
        author: { id: '11', login: 'bob' },
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
      settings: { acceptedReporters: ['alice', 'carol'] },
    } as never)

    expect(result).toEqual({ ok: true, itemCount: 1 })
    const issueInsert = inserted.find((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'issue',
    ) as { externalId: string }
    expect(issueInsert.externalId).toBe('1')
  })
})
