import { syncTaskQueueFromForges } from './task-queue'

const DEFAULT_INTERVAL_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let lastSyncAt: Date | null = null
let lastError: string | null = null
let lastResult: Awaited<ReturnType<typeof syncTaskQueueFromForges>> | null = null

export function getQueueSchedulerStatus() {
  return {
    intervalMs: Number(process.env.TASK_QUEUE_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
    running,
    lastSyncAt,
    lastError,
    lastResult,
  }
}

export async function runQueueSync(reason: 'startup' | 'interval' | 'manual' = 'interval') {
  if (running) {
    return { skipped: true as const, reason: 'already_running', ...getQueueSchedulerStatus() }
  }
  running = true
  lastError = null
  try {
    const result = await syncTaskQueueFromForges({ reason: `scheduler_${reason}` })
    lastResult = result
    lastSyncAt = new Date()
    console.info(
      `[task-queue] ${reason}: repos=${result.repositories} ok=${result.ok} failed=${result.failed} items=${result.itemCount}`,
    )
    return { skipped: false as const, ...result }
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'queue sync failed'
    console.warn(`[task-queue] ${reason} failed:`, lastError)
    throw err
  } finally {
    running = false
  }
}

export function startQueueScheduler() {
  if (timer) return
  const intervalMs = Number(process.env.TASK_QUEUE_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS

  setTimeout(() => {
    void runQueueSync('startup').catch(() => {})
  }, 3_000).unref?.()

  timer = setInterval(() => {
    void runQueueSync('interval').catch(() => {})
  }, intervalMs)
  timer.unref?.()
  console.info(`[task-queue] scheduler started (every ${Math.round(intervalMs / 1000)}s)`)
}
