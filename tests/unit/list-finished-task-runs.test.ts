import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '../../server/utils/db'
import {
  listFinishedTaskRuns,
  parseFinishedTaskRunsWindowHours,
} from '../../server/services/tasks'

function finishedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    title: 'Implement feature',
    externalId: '36',
    externalUrl: 'https://example.com/issues/36',
    taskType: 'github_issue',
    forgeType: 'github',
    provider: 'cursor',
    status: 'succeeded',
    startedAt: new Date('2026-10-16T10:00:00Z'),
    finishedAt: new Date('2026-10-16T10:05:00Z'),
    durationMs: 300_000,
    exitCode: 0,
    errorSummary: null,
    resultMetadata: {
      branch: 'ai/issue-36',
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
        totalTokens: 140,
      },
    },
    ...overrides,
  }
}

function mockDb(rows: Array<{ run: ReturnType<typeof finishedRun>, repositoryName: string | null }>, total: number) {
  const offset = vi.fn().mockResolvedValue(rows)
  const limit = vi.fn().mockReturnValue({ offset })
  const orderBy = vi.fn().mockReturnValue({ limit })
  const leftJoin = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ orderBy }),
  })
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ leftJoin }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ c: total }]),
        }),
      }),
  } as never)
  return { orderBy, limit, offset, leftJoin }
}

describe('listFinishedTaskRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps finished runs with token usage and repository name', async () => {
    mockDb([{ run: finishedRun(), repositoryName: 'ai-worker' }], 1)

    const result = await listFinishedTaskRuns({ windowHours: 24, pageSize: 20 })

    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(20)
    expect(result.total).toBe(1)
    expect(result.windowHours).toBe(24)
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'run-1',
        title: 'Implement feature',
        externalId: '36',
        provider: 'cursor',
        status: 'succeeded',
        repositoryName: 'ai-worker',
        durationMs: 300_000,
        branch: 'ai/issue-36',
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 10,
          cacheWriteTokens: 2,
          totalTokens: 140,
          totalCostUsd: null,
        },
      }),
    ])
  })

  it('returns null usage and branch when metadata lacks them', async () => {
    mockDb([{
      run: finishedRun({ resultMetadata: {}, title: null, provider: null }),
      repositoryName: null,
    }], 1)

    const result = await listFinishedTaskRuns({ page: 1, pageSize: 10 })

    expect(result.items[0]).toEqual(expect.objectContaining({
      title: null,
      provider: null,
      repositoryName: null,
      branch: null,
      usage: null,
    }))
  })

  it('omits time filter when windowHours is null (all finished tasks)', async () => {
    const { leftJoin } = mockDb([], 0)

    const result = await listFinishedTaskRuns({ windowHours: null, page: 2, pageSize: 10 })

    expect(result.windowHours).toBeNull()
    expect(result.page).toBe(2)
    expect(result.pageSize).toBe(10)
    expect(leftJoin).toHaveBeenCalled()
  })

  it('clamps page, pageSize, and windowHours', async () => {
    const { limit, offset } = mockDb([], 0)

    const result = await listFinishedTaskRuns({
      windowHours: 999,
      page: 0,
      pageSize: 500,
    })

    expect(result.windowHours).toBe(168)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(100)
    expect(limit).toHaveBeenCalledWith(100)
    expect(offset).toHaveBeenCalledWith(0)
  })

  it('uses limit as pageSize when pageSize is omitted', async () => {
    const { limit } = mockDb([], 0)

    const result = await listFinishedTaskRuns({ windowHours: 24, limit: 50 })

    expect(result.pageSize).toBe(50)
    expect(limit).toHaveBeenCalledWith(50)
  })

  it('clamps windowHours minimum to 1', async () => {
    mockDb([], 0)

    const result = await listFinishedTaskRuns({ windowHours: 0, pageSize: 5 })

    expect(result.windowHours).toBe(1)
  })
})

describe('parseFinishedTaskRunsWindowHours', () => {
  it('treats missing, empty, and all as no time window', () => {
    expect(parseFinishedTaskRunsWindowHours(undefined)).toBeNull()
    expect(parseFinishedTaskRunsWindowHours(null)).toBeNull()
    expect(parseFinishedTaskRunsWindowHours('')).toBeNull()
    expect(parseFinishedTaskRunsWindowHours('all')).toBeNull()
  })

  it('parses and clamps numeric window hours', () => {
    expect(parseFinishedTaskRunsWindowHours('24')).toBe(24)
    expect(parseFinishedTaskRunsWindowHours(7)).toBe(7)
    expect(parseFinishedTaskRunsWindowHours(0)).toBe(1)
    expect(parseFinishedTaskRunsWindowHours(999)).toBe(168)
    expect(parseFinishedTaskRunsWindowHours('nope')).toBe(24)
  })
})

describe('finished runs API route', () => {
  it('wires parseFinishedTaskRunsWindowHours into listFinishedTaskRuns', () => {
    const api = readFileSync(
      new URL('../../server/api/v1/runs/finished.get.ts', import.meta.url),
      'utf8',
    )
    expect(api).toContain('parseFinishedTaskRunsWindowHours(q.windowHours)')
    expect(api).toContain('listFinishedTaskRuns({')
    expect(api).toContain('Number(q.page) || 1')
    expect(api).toContain('Number(q.pageSize) || 20')
  })
})

