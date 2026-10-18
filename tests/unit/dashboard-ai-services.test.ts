import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
  checkDatabaseConnectivity: vi.fn(),
}))

vi.mock('../../server/services/repositories', () => ({
  repositoryCounts: vi.fn(),
}))

vi.mock('../../server/services/providers', () => ({
  listProviders: vi.fn(),
}))

vi.mock('../../server/services/provider-plans', () => ({
  getProviderPlanSnapshots: vi.fn(),
}))

vi.mock('../../server/services/worker', () => ({
  getWorkerStatus: vi.fn(),
  listRecentWorkerEvents: vi.fn(),
}))

vi.mock('../../server/services/settings', () => ({
  getSettings: vi.fn(),
}))

vi.mock('../../server/services/tasks', () => ({
  taskMetrics: vi.fn(),
  listFinishedTaskRuns: vi.fn(),
}))

vi.mock('../../server/services/setup-readiness', () => ({
  getSetupReadiness: vi.fn(),
}))

import { checkDatabaseConnectivity, getDb } from '../../server/utils/db'
import { repositoryCounts } from '../../server/services/repositories'
import { listProviders } from '../../server/services/providers'
import { getProviderPlanSnapshots } from '../../server/services/provider-plans'
import { getWorkerStatus, listRecentWorkerEvents } from '../../server/services/worker'
import { getSettings } from '../../server/services/settings'
import { listFinishedTaskRuns, taskMetrics } from '../../server/services/tasks'
import { getSetupReadiness } from '../../server/services/setup-readiness'
import { getDashboard } from '../../server/services/dashboard'

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    providerType: 'cursor',
    displayName: 'Cursor CLI',
    isEnabled: true,
    isDefault: true,
    config: {},
    hasSecret: true,
    hasStoredSecret: true,
    secretSource: 'stored' as const,
    lastHealthCheckAt: new Date('2026-10-18T12:00:00Z'),
    healthStatus: 'healthy',
    healthMessage: null,
    detectedVersion: '1.0.0',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-10-18T12:00:00Z'),
    ...overrides,
  }
}

function stubDashboardDeps(providers: ReturnType<typeof provider>[]) {
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
        groupBy: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as never)

  vi.mocked(repositoryCounts).mockResolvedValue({
    total: 0,
    enabled: 0,
    unhealthy: 0,
  } as never)
  vi.mocked(taskMetrics).mockResolvedValue({
    windowHours: 24,
    running: 0,
    queued: 0,
    succeeded: 0,
    failed: 0,
    avgDurationMs: null,
    totalDurationMs: 0,
    byProvider: [],
  })
  vi.mocked(getWorkerStatus).mockResolvedValue({
    heartbeatStale: false,
  } as never)
  vi.mocked(listProviders).mockResolvedValue(providers as never)
  vi.mocked(listRecentWorkerEvents).mockResolvedValue([])
  vi.mocked(listFinishedTaskRuns).mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    windowHours: 24,
  })
  vi.mocked(checkDatabaseConnectivity).mockResolvedValue({ ok: true, message: 'connected' })
  vi.mocked(getProviderPlanSnapshots).mockResolvedValue([])
  vi.mocked(getSettings).mockResolvedValue({
    defaultAiProvider: 'cursor',
    maxGlobalConcurrentTasks: 2,
    pollIntervalSeconds: 30,
    configVersion: 1,
  } as never)
  vi.mocked(getSetupReadiness).mockResolvedValue({
    providers: { ok: true },
    connections: { ok: true, issue: null },
    repositories: { ok: true, issue: null },
  } as never)
}

describe('getDashboard aiServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns only providers with healthStatus healthy', async () => {
    stubDashboardDeps([
      provider({
        providerType: 'cursor',
        displayName: 'Cursor CLI',
        healthStatus: 'healthy',
        isDefault: true,
      }),
      provider({
        id: 'p2',
        providerType: 'claude',
        displayName: 'Claude Code CLI',
        healthStatus: 'unhealthy',
        isDefault: false,
        isEnabled: true,
      }),
      provider({
        id: 'p3',
        providerType: 'codex',
        displayName: 'Codex CLI',
        healthStatus: 'degraded',
        isDefault: false,
        isEnabled: false,
      }),
      provider({
        id: 'p4',
        providerType: 'gemini',
        displayName: 'Gemini CLI',
        healthStatus: 'unknown',
        isDefault: false,
        isEnabled: false,
        hasSecret: false,
        secretSource: null,
      }),
      provider({
        id: 'p5',
        providerType: 'copilot',
        displayName: 'GitHub Copilot CLI',
        healthStatus: 'healthy',
        isDefault: false,
        isEnabled: true,
      }),
    ])

    const dash = await getDashboard(24)

    expect(dash.aiServices.map((s) => s.providerType)).toEqual(['cursor', 'copilot'])
    expect(dash.aiServices.every((s) => s.healthStatus === 'healthy')).toBe(true)
  })

  it('excludes orphaned unassigned usage entries which are never healthy', async () => {
    stubDashboardDeps([
      provider({ healthStatus: 'healthy' }),
    ])
    vi.mocked(taskMetrics).mockResolvedValue({
      windowHours: 24,
      running: 0,
      queued: 0,
      succeeded: 1,
      failed: 0,
      avgDurationMs: 1000,
      totalDurationMs: 1000,
      byProvider: [{
        provider: 'unassigned',
        runs: 1,
        succeeded: 1,
        failed: 0,
        running: 0,
        cancelled: 0,
        interrupted: 0,
        other: 0,
        successRate: 100,
        avgDurationMs: 1000,
        totalDurationMs: 1000,
        byTaskType: [],
      }],
    })

    const dash = await getDashboard(24)

    expect(dash.aiServices.map((s) => s.providerType)).toEqual(['cursor'])
    expect(dash.aiServices.some((s) => s.providerType === 'unassigned')).toBe(false)
  })

  it('returns an empty aiServices list when no providers are healthy', async () => {
    stubDashboardDeps([
      provider({ healthStatus: 'unhealthy' }),
      provider({
        id: 'p2',
        providerType: 'claude',
        displayName: 'Claude Code CLI',
        healthStatus: 'unknown',
        isDefault: false,
      }),
    ])

    const dash = await getDashboard(24)

    expect(dash.aiServices).toEqual([])
  })

  it('still warns about enabled providers without credentials even when they are not healthy', async () => {
    stubDashboardDeps([
      provider({
        healthStatus: 'unknown',
        isEnabled: true,
        hasSecret: false,
        secretSource: null,
        isDefault: true,
      }),
    ])
    vi.mocked(getSetupReadiness).mockResolvedValue({
      providers: { ok: false },
      connections: { ok: true, issue: null },
      repositories: { ok: true, issue: null },
    } as never)

    const dash = await getDashboard(24)

    expect(dash.aiServices).toEqual([])
    expect(dash.warnings).toContain('Cursor CLI is enabled but has no credentials')
  })
})
