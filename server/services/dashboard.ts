import { desc } from 'drizzle-orm'
import { taskRuns } from '#db/schema'
import { checkDatabaseConnectivity, getDb } from '#utils/db'
import { repositoryCounts } from './repositories'
import { listProviders } from './providers'
import { getWorkerStatus, listRecentWorkerEvents } from './worker'
import { taskMetrics } from './tasks'

export async function getDashboard(windowHours = 24) {
  const db = getDb()
  const [repos, metrics, worker, providers, events, recentRuns, dbHealth] = await Promise.all([
    repositoryCounts(),
    taskMetrics(windowHours),
    getWorkerStatus(),
    listProviders(),
    listRecentWorkerEvents(10),
    db.select().from(taskRuns).orderBy(desc(taskRuns.createdAt)).limit(10),
    checkDatabaseConnectivity(),
  ])

  const latestFailures = recentRuns.filter((r) => r.status === 'failed').slice(0, 5)
  const providerAvailability = Object.fromEntries(
    providers.map((p) => [p.providerType, {
      healthStatus: p.healthStatus,
      detectedVersion: p.detectedVersion,
      isEnabled: p.isEnabled,
    }]),
  )

  return {
    windowHours,
    repositories: repos,
    worker,
    tasks: metrics,
    providers: providerAvailability,
    recentRuns,
    recentEvents: events,
    latestFailures,
    database: dbHealth,
    warnings: [
      ...(repos.unhealthy > 0 ? [`${repos.unhealthy} repositor${repos.unhealthy === 1 ? 'y has' : 'ies have'} unhealthy status`] : []),
      ...(worker.heartbeatStale ? ['Worker heartbeat is stale or unavailable'] : []),
      ...(!dbHealth.ok ? ['Database connectivity issue'] : []),
    ],
  }
}
