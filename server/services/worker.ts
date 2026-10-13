import { and, desc, eq, inArray } from 'drizzle-orm'
import { controlRequests, workerEvents, workerState } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { writeAudit } from './audit'
import { exportWorkerConfig } from './config-sync'
import { getSettings } from './settings'

const HEARTBEAT_STALE_MS = 1000 * 90

export type ActiveTask = {
  repositoryName?: string
  taskType?: string
  externalId?: string
  title?: string
  branch?: string
  pid?: number
  startedAt?: string
}

export async function ensureWorkerStateRow() {
  const db = getDb()
  await db.insert(workerState).values({ id: 1 }).onConflictDoNothing()
}

export async function getWorkerStatus() {
  await ensureWorkerStateRow()
  const db = getDb()
  const [row] = await db.select().from(workerState).where(eq(workerState.id, 1)).limit(1)
  const settings = await getSettings()
  const heartbeatAt = row?.lastHeartbeatAt?.getTime() ?? 0
  const stale = !heartbeatAt || (Date.now() - heartbeatAt) > HEARTBEAT_STALE_MS

  return {
    status: stale && row?.status === 'running' ? 'unknown' : (row?.status ?? 'unknown'),
    lastHeartbeatAt: row?.lastHeartbeatAt ?? null,
    lastPollAt: row?.lastPollAt ?? null,
    lastSuccessfulPollAt: row?.lastSuccessfulPollAt ?? null,
    configVersionLoaded: row?.configVersionLoaded ?? null,
    configVersionCurrent: settings.configVersion,
    hostname: row?.hostname ?? null,
    pid: row?.pid ?? null,
    version: row?.version ?? null,
    providerAvailability: row?.providerAvailability ?? {},
    activeTaskCount: row?.activeTaskCount ?? 0,
    activeTasks: (row?.activeTasks ?? []) as ActiveTask[],
    heartbeatStale: stale,
    updatedAt: row?.updatedAt ?? null,
  }
}

export async function requestWorkerControl(
  action: 'reload_config' | 'start' | 'stop' | 'restart',
  actor: { id: string, username: string },
  payload: Record<string, unknown> = {},
  ipHash?: string,
) {
  const db = getDb()

  // Idempotency: cancel duplicate pending same action
  const pending = await db.select().from(controlRequests).where(and(
    eq(controlRequests.action, action),
    inArray(controlRequests.status, ['pending', 'acknowledged']),
  ))

  if (pending.length > 0) {
    return {
      id: pending[0].id,
      action: pending[0].action,
      status: pending[0].status,
      deduplicated: true,
    }
  }

  if (action === 'reload_config') {
    await exportWorkerConfig(actor)
  }

  const [row] = await db.insert(controlRequests).values({
    action,
    status: 'pending',
    requestedBy: actor.id,
    payload: { graceful: true, ...payload },
  }).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: `worker.${action}`,
    targetType: 'control_request',
    targetId: row.id,
    metadata: { action },
    ipHash,
  })

  return {
    id: row.id,
    action: row.action,
    status: row.status,
    deduplicated: false,
  }
}

export async function listRecentWorkerEvents(limit = 20) {
  const db = getDb()
  return db.select().from(workerEvents).orderBy(desc(workerEvents.createdAt)).limit(limit)
}

/** Called by the worker wrapper (authenticated via shared worker token or internal network + token). */
function activeTasksFingerprint(tasks: ActiveTask[]): string {
  return JSON.stringify(
    tasks.map((t) => ({
      repositoryName: t.repositoryName || '',
      taskType: t.taskType || '',
      externalId: t.externalId || '',
      branch: t.branch || '',
      pid: t.pid ?? null,
    })),
  )
}

export async function workerHeartbeat(input: {
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  configVersionLoaded?: number
  hostname?: string
  pid?: number
  version?: string
  providerAvailability?: Record<string, unknown>
  activeTaskCount?: number
  activeTasks?: ActiveTask[]
  pollSucceeded?: boolean
}) {
  await ensureWorkerStateRow()
  const db = getDb()
  const now = new Date()
  const activeTasks = Array.isArray(input.activeTasks) ? input.activeTasks : []

  const [prev] = await db.select({
    status: workerState.status,
    activeTasks: workerState.activeTasks,
  }).from(workerState).where(eq(workerState.id, 1)).limit(1)

  const patch: Partial<typeof workerState.$inferInsert> = {
    status: input.status,
    lastHeartbeatAt: now,
    hostname: input.hostname,
    pid: input.pid,
    version: input.version,
    providerAvailability: input.providerAvailability ?? {},
    activeTaskCount: input.activeTaskCount ?? activeTasks.length,
    activeTasks,
    updatedAt: now,
  }
  if (input.configVersionLoaded !== undefined) {
    patch.configVersionLoaded = input.configVersionLoaded
  }
  if (input.pollSucceeded) {
    patch.lastPollAt = now
    patch.lastSuccessfulPollAt = now
  } else if (input.status === 'running') {
    patch.lastPollAt = now
  }

  await db.update(workerState).set(patch).where(eq(workerState.id, 1))

  const prevTasks = (prev?.activeTasks ?? []) as ActiveTask[]
  const assignmentChanged = !prev
    || prev.status !== input.status
    || activeTasksFingerprint(prevTasks) !== activeTasksFingerprint(activeTasks)

  if (assignmentChanged) {
    try {
      const { notifyQueueChanged } = await import('./task-queue')
      notifyQueueChanged('heartbeat')
    } catch {
      /* optional during early boot */
    }
  }
}

export async function claimControlRequests(limit = 5) {
  const db = getDb()
  const pending = await db.select().from(controlRequests)
    .where(eq(controlRequests.status, 'pending'))
    .orderBy(controlRequests.createdAt)
    .limit(limit)

  const claimed = []
  for (const req of pending) {
    const [row] = await db.update(controlRequests).set({
      status: 'acknowledged',
      acknowledgedAt: new Date(),
    }).where(and(
      eq(controlRequests.id, req.id),
      eq(controlRequests.status, 'pending'),
    )).returning()
    if (row) claimed.push(row)
  }
  return claimed
}

export async function completeControlRequest(
  id: string,
  ok: boolean,
  result: Record<string, unknown>,
) {
  const db = getDb()
  const [row] = await db.update(controlRequests).set({
    status: ok ? 'completed' : 'failed',
    completedAt: new Date(),
    result,
  }).where(eq(controlRequests.id, id)).returning()
  if (!row) throw new AppError(404, 'Control request not found', 'not_found')

  await db.insert(workerEvents).values({
    eventType: `control.${row.action}.${ok ? 'completed' : 'failed'}`,
    workerStatus: null,
    message: ok ? `Control action ${row.action} completed` : `Control action ${row.action} failed`,
    metadata: result,
  })

  return row
}

export async function recordWorkerEvent(input: {
  eventType: string
  workerStatus?: 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  message?: string
  metadata?: Record<string, unknown>
  configVersion?: number
}) {
  const db = getDb()
  await db.insert(workerEvents).values({
    eventType: input.eventType,
    workerStatus: input.workerStatus,
    message: input.message,
    metadata: input.metadata ?? {},
    configVersion: input.configVersion,
  })
}
