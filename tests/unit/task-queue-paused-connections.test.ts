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
    listPausedConnectionIds: vi.fn(async () => ['paused-conn']),
    getConnection: vi.fn(),
    getConnectionAccessToken: vi.fn(),
  }
})

vi.mock('../../server/services/queue-events', () => ({
  publishQueueUpdated: vi.fn(),
}))

vi.mock('../../server/services/worker', () => ({
  getWorkerStatus: vi.fn(async () => ({ status: 'stopped', activeTasks: [] })),
}))

vi.mock('../../server/services/forge-github', () => ({
  listGitHubAiIssues: vi.fn(async () => []),
  listGitHubAiPullRequests: vi.fn(async () => []),
}))

vi.mock('../../server/services/forge-gitlab', () => ({
  listGitLabAiIssues: vi.fn(async () => []),
  listGitLabAiMergeRequests: vi.fn(async () => []),
}))

import { getDb } from '../../server/utils/db'
import { getConnection, listPausedConnectionIds } from '../../server/services/connections'
import { syncQueueForRepositoryFullName, syncTaskQueueFromForges } from '../../server/services/task-queue'
import { publishQueueUpdated } from '../../server/services/queue-events'

describe('task queue skips disabled connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters out repos from paused connections during forge sync', async () => {
    const repos = [
      {
        id: 'r1',
        name: 'kept',
        connectionId: 'active-conn',
        isEnabled: true,
        isArchived: false,
        forgeType: 'github',
      },
      {
        id: 'r2',
        name: 'hidden',
        connectionId: 'paused-conn',
        isEnabled: true,
        isArchived: false,
        forgeType: 'github',
      },
    ]

    // syncAllRepositoryQueues -> select repos, then each syncRepositoryQueue hits DB again.
    // Keep syncRepositoryQueue from failing by making subsequent selects empty/simple.
    let selectCalls = 0
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1
        if (selectCalls === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(repos),
            }),
          }
        }
        // syncRepositoryQueue internals: return empty / noop shapes
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as never)

    // Avoid deep forge sync: getConnectionAccessToken throws so syncRepositoryQueue fails softly
    const { getConnectionAccessToken } = await import('../../server/services/connections')
    vi.mocked(getConnectionAccessToken).mockRejectedValue(new Error('no token'))

    const result = await syncTaskQueueFromForges({ reason: 'test' })
    expect(listPausedConnectionIds).toHaveBeenCalled()
    expect(result.repositories).toBe(1)
    expect(publishQueueUpdated).toHaveBeenCalled()
  })

  it('skips webhook queue sync when the connection is paused', async () => {
    vi.mocked(getConnection).mockResolvedValue({
      row: { id: 'paused-conn', status: 'disconnected' },
      public: {},
    } as never)

    await syncQueueForRepositoryFullName('paused-conn', 'acme/widget', 'test')
    expect(getConnection).toHaveBeenCalledWith('paused-conn')
    expect(publishQueueUpdated).not.toHaveBeenCalled()
  })

  it('skips webhook queue sync when the connection is missing', async () => {
    vi.mocked(getConnection).mockRejectedValue(new Error('not found'))
    await syncQueueForRepositoryFullName('missing', 'acme/widget', 'test')
    expect(publishQueueUpdated).not.toHaveBeenCalled()
  })
})
