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
  }
})

import { getDb } from '../../server/utils/db'
import { listPausedConnectionIds } from '../../server/services/connections'
import { listRepositories } from '../../server/services/repositories'

describe('listRepositories hides disabled-connection repos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds a filter excluding paused connection ids', async () => {
    const whereArgs: unknown[] = []
    const orderBy = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        offset: vi.fn().mockResolvedValue([]),
      }),
    })
    const countWhere = vi.fn().mockResolvedValue([{ c: 0 }])
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((clause) => {
              whereArgs.push(clause)
              return { orderBy }
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: countWhere,
          }),
        }),
    } as never)

    const result = await listRepositories({ page: 1, pageSize: 20 })
    expect(listPausedConnectionIds).toHaveBeenCalled()
    expect(result.total).toBe(0)
    expect(result.items).toEqual([])
    expect(whereArgs.length).toBeGreaterThan(0)
  })
})
