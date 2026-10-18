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
  listFinishedTaskRuns: vi.fn(),
  taskMetrics: vi.fn(),
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
    id: 'p-1',
    providerType: 'cursor',
    displayName: 'Cursor',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function emptyMetrics() {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    running: 0,
    cancelled: 0,
    interrupted: 0,
    other: 0,
    byProvider: [] as Array<{ provider: string; runs: number; succeeded: number; failed: number; running: number; cancelled: number; interrupted: number; other: number; successRate: number | null; avgDurationMs: number | null; totalDurationMs: number; byTaskType: unknown[] }>,
    byTaskType: [],
  }
}

function mockDashboardDeps(providers: ReturnType<typeof provider>[], metrics = emptyMetrics()) {
  const orderBy = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
  const groupBy = vi.fn().mockResolvedValue([])
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn()
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ orderBy }) })
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ groupBy }) }),
  } as never)

  vi.mocked(repositoryCounts).mockResolvedValue({ total: 0, enabled: 0, unhealthy: 0 })
  vi.mocked(taskMetrics).mockResolvedValue(metrics as never)
  vi.mocked(getWorkerStatus).mockResolvedValue({
    status: 'running',
    lastHeartbeatAt: new Date(),
    lastPollAt: null,
    lastSuccessfulPollAt: null,
    configVersionLoaded: 1,
    configVersionCurrent: 1,
    hostname: 'test',
    pid: 1,
    version: '1',
    providerAvailability: {},
    activeTaskCount: 0,
    activeTasks: [],
    heartbeatStale: false,
    updatedAt: new Date(),
  } as never)
  vi.mocked(listProviders).mockResolvedValue(providers as never)
  vi.mocked(listRecentWorkerEvents).mockResolvedValue([])
  vi.mocked(listFinishedTaskRuns).mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    windowHours: 24,
  } as never)
  vi.mocked(checkDatabaseConnectivity).mockResolvedValue({ ok: true, message: 'connected' })
  vi.mocked(getProviderPlanSnapshots).mockResolvedValue([])
  vi.mocked(getSettings).mockResolvedValue({
    defaultAiProvider: 'cursor',
    maxGlobalConcurrentTasks: 2,
    pollIntervalSeconds: 30,
    configVersion: 1,
  } as never)
  vi.mocked(getSetupReadiness).mockResolvedValue({
    connections: { ok: true, total: 1, active: 1, issue: null },
    providers: { ok: true, total: 5, active: 1, issue: null },
    repositories: { ok: true, total: 1, enabled: 1, issue: null },
    navWarnings: { connections: false, providers: false, repositories: false },
  } as never)
}

describe('getDashboard aiServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns only providers with healthStatus healthy', async () => {
    mockDashboardDeps([
      provider({ providerType: 'cursor', displayName: 'Cursor', healthStatus: 'healthy', isDefault: true }),
      provider({ providerType: 'claude', displayName: 'Claude', healthStatus: 'unhealthy', isDefault: false, isEnabled: false }),
      provider({ providerType: 'codex', displayName: 'Codex', healthStatus: 'degraded', isDefault: false, isEnabled: false }),
      provider({ providerType: 'gemini', displayName: 'Gemini', healthStatus: 'unknown', isDefault: false, isEnabled: false }),
      provider({ providerType: 'copilot', displayName: 'Copilot', healthStatus: 'healthy', isDefault: false, isEnabled: true }),
    ])

    const result = await getDashboard(24)

    expect(result.aiServices.map((s) => s.providerType)).toEqual(['cursor', 'copilot'])
    expect(result.aiServices.every((s) => s.healthStatus === 'healthy')).toBe(true)
  })

  it('does not surface orphaned/unassigned usage entries in aiServices', async () => {
    mockDashboardDeps(
      [provider({ providerType: 'cursor', healthStatus: 'healthy' })],
      {
        ...emptyMetrics(),
        byProvider: [{
          provider: 'unassigned',
          runs: 2,
          succeeded: 1,
          failed: 1,
          running: 0,
          cancelled: 0,
          interrupted: 0,
          other: 0,
          successRate: 50,
          avgDurationMs: 1000,
          totalDurationMs: 2000,
          byTaskType: [],
        }],
      },
    )

    const result = await getDashboard(24)

    expect(result.aiServices.map((s) => s.providerType)).toEqual(['cursor'])
    expect(result.aiServices.some((s) => s.providerType === 'unassigned')).toBe(false)
  })

  it('still warns about enabled providers without secrets even when unhealthy', async () => {
    mockDashboardDeps([
      provider({
        providerType: 'claude',
        displayName: 'Claude',
        healthStatus: 'unhealthy',
        isEnabled: true,
        isDefault: false,
        hasSecret: false,
        secretSource: null,
      }),
      provider({
        providerType: 'cursor',
        displayName: 'Cursor',
        healthStatus: 'healthy',
        isEnabled: true,
        isDefault: true,
        hasSecret: true,
      }),
    ])

    const result = await getDashboard(24)

    expect(result.aiServices.map((s) => s.providerType)).toEqual(['cursor'])
    expect(result.warnings).toContain('Claude is enabled but has no credentials')
  })
})
