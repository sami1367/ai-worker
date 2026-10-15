import { count, desc } from 'drizzle-orm'
import { taskQueueItems, taskRuns } from '#db/schema'
import { checkDatabaseConnectivity, getDb } from '#utils/db'
import { repositoryCounts } from './repositories'
import { listProviders } from './providers'
import { getProviderPlanSnapshots } from './provider-plans'
import { getWorkerStatus, listRecentWorkerEvents } from './worker'
import { getSettings } from './settings'
import { taskMetrics, type ProviderUsageStats } from './tasks'

async function queuePhaseCounts() {
  const db = getDb()
  const rows = await db.select({
    phase: taskQueueItems.phase,
    c: count(),
  }).from(taskQueueItems).groupBy(taskQueueItems.phase)

  const phases: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    const n = Number(r.c) || 0
    phases[r.phase] = n
    total += n
  }

  return {
    total,
    working: (phases.working || 0) + (phases.reviewing || 0),
    queued: (phases.queued || 0) + (phases.review_queued || 0),
    failed: phases.failed || 0,
    completed: phases.completed || 0,
    byPhase: phases,
  }
}

function emptyUsage(provider: string): ProviderUsageStats {
  return {
    provider,
    runs: 0,
    succeeded: 0,
    failed: 0,
    running: 0,
    cancelled: 0,
    interrupted: 0,
    other: 0,
    successRate: null,
    avgDurationMs: null,
    totalDurationMs: 0,
    byTaskType: [],
  }
}

export async function getDashboard(windowHours = 24) {
  const db = getDb()
  const [
    repos,
    metrics,
    worker,
    providers,
    events,
    recentRuns,
    dbHealth,
    plans,
    queue,
    settings,
  ] = await Promise.all([
    repositoryCounts(),
    taskMetrics(windowHours),
    getWorkerStatus(),
    listProviders(),
    listRecentWorkerEvents(10),
    db.select().from(taskRuns).orderBy(desc(taskRuns.createdAt)).limit(10),
    checkDatabaseConnectivity(),
    getProviderPlanSnapshots(),
    queuePhaseCounts(),
    getSettings(),
  ])

  const latestFailures = recentRuns.filter((r) => r.status === 'failed').slice(0, 5)
  const usageByProvider = new Map<string, ProviderUsageStats>(
    metrics.byProvider.map((u) => [u.provider, u]),
  )
  const planByProvider = new Map<string, (typeof plans)[number]>(
    plans.map((p) => [p.providerType, p]),
  )

  const aiServices = providers.map((p) => {
    const usage = usageByProvider.get(p.providerType) || emptyUsage(p.providerType)
    const plan = planByProvider.get(p.providerType) ?? null
    return {
      providerType: p.providerType,
      displayName: p.displayName,
      isEnabled: p.isEnabled,
      isDefault: p.isDefault || settings.defaultAiProvider === p.providerType,
      healthStatus: p.healthStatus,
      healthMessage: p.healthMessage,
      detectedVersion: p.detectedVersion,
      hasSecret: p.hasSecret,
      secretSource: p.secretSource,
      lastHealthCheckAt: p.lastHealthCheckAt,
      usage,
      plan,
    }
  })

  // Surface orphaned usage (runs with null/unknown provider) when present.
  for (const u of metrics.byProvider) {
    if (u.provider === 'unassigned' || !providers.some((p) => p.providerType === u.provider)) {
      if (aiServices.some((s) => s.providerType === u.provider)) continue
      aiServices.push({
        providerType: u.provider,
        displayName: u.provider === 'unassigned' ? 'Unassigned provider' : u.provider,
        isEnabled: false,
        isDefault: false,
        healthStatus: 'unknown',
        healthMessage: null,
        detectedVersion: null,
        hasSecret: false,
        secretSource: null,
        lastHealthCheckAt: null,
        usage: u,
        plan: null,
      })
    }
  }

  const providerOrder = ['cursor', 'claude', 'unassigned']
  aiServices.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    const ai = providerOrder.indexOf(a.providerType)
    const bi = providerOrder.indexOf(b.providerType)
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    return a.displayName.localeCompare(b.displayName)
  })

  const decided = metrics.succeeded + metrics.failed
  const successRate = decided > 0 ? Math.round((metrics.succeeded / decided) * 1000) / 10 : null

  return {
    windowHours,
    repositories: repos,
    worker,
    tasks: {
      ...metrics,
      successRate,
    },
    queue,
    settings: {
      defaultAiProvider: settings.defaultAiProvider,
      maxGlobalConcurrentTasks: settings.maxGlobalConcurrentTasks,
      pollIntervalSeconds: settings.pollIntervalSeconds,
      configVersion: settings.configVersion,
    },
    aiServices,
    providers: Object.fromEntries(
      providers.map((p) => [p.providerType, {
        healthStatus: p.healthStatus,
        detectedVersion: p.detectedVersion,
        isEnabled: p.isEnabled,
        isDefault: p.isDefault,
      }]),
    ),
    recentRuns,
    recentEvents: events,
    latestFailures,
    database: dbHealth,
    warnings: [
      ...(repos.unhealthy > 0 ? [`${repos.unhealthy} repositor${repos.unhealthy === 1 ? 'y has' : 'ies have'} unhealthy status`] : []),
      ...(worker.heartbeatStale ? ['Worker heartbeat is stale or unavailable'] : []),
      ...(!dbHealth.ok ? ['Database connectivity issue'] : []),
      ...aiServices
        .filter((s) => s.providerType === 'cursor' || s.providerType === 'claude')
        .filter((s) => s.isEnabled && !s.hasSecret)
        .map((s) => `${s.displayName} is enabled but has no credentials`),
      ...aiServices
        .filter((s) => s.plan?.error && s.hasSecret)
        .map((s) => `${s.displayName}: ${s.plan!.error}`),
    ],
  }
}
