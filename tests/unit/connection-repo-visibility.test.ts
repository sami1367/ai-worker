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

  it('orders enabled repositories before disabled ones', async () => {
    const orderBy = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        offset: vi.fn().mockResolvedValue([]),
      }),
    })
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ orderBy }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ c: 0 }]),
          }),
        }),
    } as never)

    await listRepositories({ page: 1, pageSize: 20 })

    expect(orderBy).toHaveBeenCalled()
    const orderArgs = orderBy.mock.calls[0] as Array<{
      queryChunks?: Array<{ name?: string, value?: string[] }>
    }>
    expect(orderArgs).toHaveLength(2)
    const columnNames = orderArgs.map((arg) =>
      arg.queryChunks?.find((c) => typeof c.name === 'string')?.name,
    )
    expect(columnNames).toEqual(['is_enabled', 'updated_at'])
    // desc(true) sorts enabled (true) before disabled (false)
    for (const arg of orderArgs) {
      const direction = arg.queryChunks
        ?.filter((c) => Array.isArray(c.value))
        .map((c) => c.value!.join(''))
        .join('')
      expect(direction).toMatch(/desc/i)
    }
  })
})
