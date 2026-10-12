import { syncAllConnections } from './discovery'
import { deferPendingClones, enableConnectionLinkedRepositoriesOnce } from './registration'

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let lastSyncAt: Date | null = null
let lastResult: Awaited<ReturnType<typeof syncAllConnections>> | null = null
let lastError: string | null = null

export function getDiscoverySchedulerStatus() {
  return {
    intervalMs: Number(process.env.DISCOVERY_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
    running,
    lastSyncAt,
    lastError,
    lastResult: lastResult
      ? {
          connections: lastResult.connections,
          discovered: lastResult.discovered,
          registeredNew: lastResult.registeredNew,
          syncedAt: lastResult.syncedAt,
        }
      : null,
  }
}

export async function runDiscoverySyncAll(reason: 'startup' | 'interval' | 'manual' = 'interval') {
  if (running) {
    return { skipped: true as const, reason: 'already_running', ...getDiscoverySchedulerStatus() }
  }
  running = true
  lastError = null
  try {
    if (reason === 'startup') {
      // One-time migration to lazy-clone defaults (flagged inside enable…Once)
      const migrated = await enableConnectionLinkedRepositoriesOnce()
      if (!migrated.skipped) {
        await deferPendingClones({ username: 'system' })
      }
    }
    const result = await syncAllConnections()
    lastResult = result
    lastSyncAt = new Date()
    console.info(
      `[discovery] ${reason}: connections=${result.connections} discovered=${result.discovered} registeredNew=${result.registeredNew}`,
    )
    return { skipped: false as const, ...result }
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'discovery sync failed'
    console.warn(`[discovery] ${reason} failed:`, lastError)
    throw err
  } finally {
    running = false
  }
}

export function startDiscoveryScheduler() {
  if (timer) return
  const intervalMs = Number(process.env.DISCOVERY_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS

  // Initial backfill shortly after boot (let DB settle)
  setTimeout(() => {
    void runDiscoverySyncAll('startup').catch(() => {})
  }, 5_000).unref?.()

  timer = setInterval(() => {
    void runDiscoverySyncAll('interval').catch(() => {})
  }, intervalMs)
  timer.unref?.()
  console.info(`[discovery] scheduler started (every ${Math.round(intervalMs / 60000)} min)`)
}
