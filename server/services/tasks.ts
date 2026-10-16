import { and, avg, count, desc, eq, gte, ilike, inArray, lte, or, sql, sum } from 'drizzle-orm'
import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { repositories, taskRuns } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { workerBaseDir } from '#utils/paths'
import { newCorrelationId } from '#utils/crypto'

export async function listTaskRuns(opts: {
  page: number
  pageSize: number
  q?: string
  repositoryId?: string
  provider?: string
  taskType?: string
  status?: string
  from?: Date
  to?: Date
}) {
  const db = getDb()
  const page = Math.max(1, opts.page)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize))
  const offset = (page - 1) * pageSize

  const conditions = []
  if (opts.repositoryId) conditions.push(eq(taskRuns.repositoryId, opts.repositoryId))
  if (opts.provider) conditions.push(eq(taskRuns.provider, opts.provider))
  if (opts.taskType) conditions.push(eq(taskRuns.taskType, opts.taskType as typeof taskRuns.taskType.enumValues[number]))
  if (opts.status) conditions.push(eq(taskRuns.status, opts.status as typeof taskRuns.status.enumValues[number]))
  if (opts.from) conditions.push(gte(taskRuns.createdAt, opts.from))
  if (opts.to) conditions.push(lte(taskRuns.createdAt, opts.to))
  if (opts.q) {
    conditions.push(or(
      ilike(taskRuns.title, `%${opts.q}%`),
      ilike(taskRuns.externalId, `%${opts.q}%`),
      ilike(taskRuns.correlationId, `%${opts.q}%`),
    ))
  }
  const where = conditions.length ? and(...conditions) : undefined

  const items = await db.select({
    run: taskRuns,
    repositoryName: repositories.name,
  }).from(taskRuns)
    .leftJoin(repositories, eq(taskRuns.repositoryId, repositories.id))
    .where(where)
    .orderBy(desc(taskRuns.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [totalRow] = await db.select({ c: count() }).from(taskRuns).where(where)

  return {
    items: items.map(({ run, repositoryName }) => ({
      ...run,
      repositoryName,
    })),
    page,
    pageSize,
    total: totalRow?.c ?? 0,
  }
}

export async function getTaskRun(id: string) {
  const db = getDb()
  const [row] = await db.select({
    run: taskRuns,
    repositoryName: repositories.name,
  }).from(taskRuns)
    .leftJoin(repositories, eq(taskRuns.repositoryId, repositories.id))
    .where(eq(taskRuns.id, id))
    .limit(1)
  if (!row) throw new AppError(404, 'Task run not found', 'not_found')
  return { ...row.run, repositoryName: row.repositoryName }
}

export async function getTaskLogTail(id: string, maxBytes = 256_000) {
  const run = await getTaskRun(id)
  if (run.logExpired) {
    return { available: false, reason: 'Log expired', content: '', path: null as string | null }
  }
  if (!run.logPath) {
    return { available: false, reason: 'No log path recorded', content: '', path: null }
  }

  const logsDir = process.env.LOGS_DIR || join(workerBaseDir(), 'logs')
  const safeName = basename(run.logPath)
  const fullPath = join(logsDir, safeName)

  try {
    await access(fullPath)
    const st = await stat(fullPath)
    const { open } = await import('node:fs/promises')
    const fh = await open(fullPath, 'r')
    try {
      const start = Math.max(0, st.size - maxBytes)
      const buf = Buffer.alloc(st.size - start)
      await fh.read(buf, 0, buf.length, start)
      return {
        available: true,
        reason: null as string | null,
        content: buf.toString('utf8'),
        path: safeName,
        size: st.size,
        truncated: start > 0,
      }
    } finally {
      await fh.close()
    }
  } catch {
    return { available: false, reason: 'Log file not found on disk', content: '', path: safeName }
  }
}

export async function* streamTaskLog(id: string, signal?: AbortSignal) {
  const run = await getTaskRun(id)
  if (!run.logPath || run.logExpired) {
    yield { type: 'error', message: 'Log unavailable' }
    return
  }
  const logsDir = process.env.LOGS_DIR || join(workerBaseDir(), 'logs')
  const fullPath = join(logsDir, basename(run.logPath))

  let position: number
  try {
    const st = await stat(fullPath)
    // Initial tail ~64KB
    position = Math.max(0, st.size - 64_000)
  } catch {
    yield { type: 'error', message: 'Log file not found' }
    return
  }

  yield { type: 'ready', path: basename(run.logPath) }

  while (!signal?.aborted) {
    try {
      const st = await stat(fullPath)
      if (st.size > position) {
        const stream = createReadStream(fullPath, { start: position, encoding: 'utf8' })
        const rl = createInterface({ input: stream, crlfDelay: Infinity })
        for await (const line of rl) {
          if (signal?.aborted) break
          yield { type: 'line', line }
        }
        position = st.size
      }

      // Stop streaming if run finished and we caught up
      const latest = await getTaskRun(id)
      const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(latest.status)
      if (terminal && st.size <= position) {
        yield { type: 'done', status: latest.status }
        return
      }
    } catch {
      yield { type: 'error', message: 'Log read error' }
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

export async function upsertTaskRunFromWorker(input: {
  repositoryName?: string
  forgeType: 'github' | 'gitlab'
  taskType: typeof taskRuns.taskType.enumValues[number]
  externalId: string
  externalUrl?: string
  title?: string
  provider?: string
  status: typeof taskRuns.status.enumValues[number]
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  errorSummary?: string
  resultMetadata?: Record<string, unknown>
  logPath?: string
  correlationId?: string
}) {
  const db = getDb()
  let repositoryId: string | null = null
  if (input.repositoryName) {
    const [repo] = await db.select().from(repositories)
      .where(and(eq(repositories.name, input.repositoryName), eq(repositories.forgeType, input.forgeType)))
      .limit(1)
    repositoryId = repo?.id ?? null
  }

  const startedAt = input.startedAt ? new Date(input.startedAt) : null
  const finishedAt = input.finishedAt ? new Date(input.finishedAt) : null
  const durationMs = startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null
  const correlationId = input.correlationId || newCorrelationId()
  const now = new Date()

  // Prefer updating an open run for the same correlation / external work item.
  if (input.correlationId) {
    const [existing] = await db.select().from(taskRuns)
      .where(eq(taskRuns.correlationId, input.correlationId))
      .limit(1)
    if (existing) {
      const [row] = await db.update(taskRuns).set({
        repositoryId: repositoryId ?? existing.repositoryId,
        forgeType: input.forgeType,
        taskType: input.taskType,
        externalId: input.externalId,
        externalUrl: input.externalUrl ?? existing.externalUrl,
        title: input.title ?? existing.title,
        provider: input.provider ?? existing.provider,
        status: input.status,
        startedAt: startedAt ?? existing.startedAt,
        finishedAt: finishedAt ?? existing.finishedAt,
        durationMs: durationMs ?? existing.durationMs ?? undefined,
        exitCode: input.exitCode ?? existing.exitCode,
        errorSummary: input.errorSummary ?? existing.errorSummary,
        resultMetadata: input.resultMetadata ?? existing.resultMetadata,
        logPath: input.logPath ? basename(input.logPath) : existing.logPath,
        updatedAt: now,
      }).where(eq(taskRuns.id, existing.id)).returning()
      try {
        const { notifyQueueChanged } = await import('./task-queue')
        notifyQueueChanged('task_run')
      } catch { /* optional */ }
      return row
    }
  }

  const openStatuses = ['queued', 'starting', 'running'] as const
  if (openStatuses.includes(input.status as typeof openStatuses[number]) || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(input.status)) {
    const [open] = await db.select().from(taskRuns).where(and(
      eq(taskRuns.forgeType, input.forgeType),
      eq(taskRuns.taskType, input.taskType),
      eq(taskRuns.externalId, input.externalId),
      inArray(taskRuns.status, ['queued', 'starting', 'running']),
    )).limit(1)
    if (open) {
      const [row] = await db.update(taskRuns).set({
        repositoryId: repositoryId ?? open.repositoryId,
        externalUrl: input.externalUrl ?? open.externalUrl,
        title: input.title ?? open.title,
        provider: input.provider ?? open.provider,
        status: input.status,
        startedAt: startedAt ?? open.startedAt,
        finishedAt: finishedAt ?? open.finishedAt,
        durationMs: durationMs ?? open.durationMs ?? undefined,
        exitCode: input.exitCode ?? open.exitCode,
        errorSummary: input.errorSummary ?? open.errorSummary,
        resultMetadata: input.resultMetadata ?? open.resultMetadata,
        logPath: input.logPath ? basename(input.logPath) : open.logPath,
        updatedAt: now,
      }).where(eq(taskRuns.id, open.id)).returning()
      try {
        const { notifyQueueChanged } = await import('./task-queue')
        notifyQueueChanged('task_run')
      } catch { /* optional */ }
      return row
    }
  }

  const [row] = await db.insert(taskRuns).values({
    repositoryId,
    forgeType: input.forgeType,
    taskType: input.taskType,
    externalId: input.externalId,
    externalUrl: input.externalUrl,
    title: input.title,
    provider: input.provider,
    status: input.status,
    startedAt,
    finishedAt,
    durationMs: durationMs ?? undefined,
    exitCode: input.exitCode,
    errorSummary: input.errorSummary,
    resultMetadata: input.resultMetadata ?? {},
    logPath: input.logPath ? basename(input.logPath) : null,
    correlationId,
    updatedAt: now,
  }).returning()

  try {
    const { notifyQueueChanged } = await import('./task-queue')
    notifyQueueChanged('task_run')
  } catch { /* optional */ }

  return row
}

export type ProviderUsageStats = {
  provider: string
  runs: number
  succeeded: number
  failed: number
  running: number
  cancelled: number
  interrupted: number
  other: number
  successRate: number | null
  avgDurationMs: number | null
  totalDurationMs: number
  byTaskType: Array<{
    taskType: string
    runs: number
    succeeded: number
    failed: number
  }>
}

export async function taskMetrics(windowHours = 24) {
  const db = getDb()
  const since = new Date(Date.now() - windowHours * 3600 * 1000)
  const [running] = await db.select({ c: count() }).from(taskRuns).where(eq(taskRuns.status, 'running'))
  const [queued] = await db.select({ c: count() }).from(taskRuns).where(eq(taskRuns.status, 'queued'))
  const [succeeded] = await db.select({ c: count() }).from(taskRuns).where(and(
    eq(taskRuns.status, 'succeeded'),
    gte(taskRuns.finishedAt, since),
  ))
  const [failed] = await db.select({ c: count() }).from(taskRuns).where(and(
    eq(taskRuns.status, 'failed'),
    gte(taskRuns.finishedAt, since),
  ))
  const [avgAll] = await db.select({
    avgDurationMs: avg(taskRuns.durationMs),
    totalDurationMs: sum(taskRuns.durationMs),
    finished: count(),
  }).from(taskRuns).where(and(
    gte(taskRuns.finishedAt, since),
    inArray(taskRuns.status, ['succeeded', 'failed', 'cancelled', 'interrupted']),
  ))

  const byProvider = await providerUsageStats(windowHours)

  return {
    windowHours,
    running: running?.c ?? 0,
    queued: queued?.c ?? 0,
    succeeded: succeeded?.c ?? 0,
    failed: failed?.c ?? 0,
    avgDurationMs: avgAll?.avgDurationMs != null ? Math.round(Number(avgAll.avgDurationMs)) : null,
    totalDurationMs: avgAll?.totalDurationMs != null ? Number(avgAll.totalDurationMs) : 0,
    byProvider,
  }
}

/** Aggregate task_runs usage for each AI provider inside the time window. */
export async function providerUsageStats(windowHours = 24): Promise<ProviderUsageStats[]> {
  const db = getDb()
  const since = new Date(Date.now() - windowHours * 3600 * 1000)

  const statusRows = await db.select({
    provider: sql<string>`coalesce(${taskRuns.provider}, 'unassigned')`.as('provider'),
    status: taskRuns.status,
    c: count(),
  }).from(taskRuns)
    .where(gte(taskRuns.createdAt, since))
    .groupBy(sql`coalesce(${taskRuns.provider}, 'unassigned')`, taskRuns.status)

  const durationRows = await db.select({
    provider: sql<string>`coalesce(${taskRuns.provider}, 'unassigned')`.as('provider'),
    avgDurationMs: avg(taskRuns.durationMs),
    totalDurationMs: sum(taskRuns.durationMs),
  }).from(taskRuns)
    .where(and(
      gte(taskRuns.createdAt, since),
      inArray(taskRuns.status, ['succeeded', 'failed', 'cancelled', 'interrupted']),
    ))
    .groupBy(sql`coalesce(${taskRuns.provider}, 'unassigned')`)

  const typeRows = await db.select({
    provider: sql<string>`coalesce(${taskRuns.provider}, 'unassigned')`.as('provider'),
    taskType: taskRuns.taskType,
    status: taskRuns.status,
    c: count(),
  }).from(taskRuns)
    .where(gte(taskRuns.createdAt, since))
    .groupBy(sql`coalesce(${taskRuns.provider}, 'unassigned')`, taskRuns.taskType, taskRuns.status)

  const map = new Map<string, ProviderUsageStats>()

  function ensure(provider: string): ProviderUsageStats {
    let row = map.get(provider)
    if (!row) {
      row = {
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
      map.set(provider, row)
    }
    return row
  }

  for (const r of statusRows) {
    const row = ensure(r.provider)
    const n = Number(r.c) || 0
    row.runs += n
    if (r.status === 'succeeded') row.succeeded += n
    else if (r.status === 'failed') row.failed += n
    else if (r.status === 'running' || r.status === 'starting') row.running += n
    else if (r.status === 'cancelled') row.cancelled += n
    else if (r.status === 'interrupted') row.interrupted += n
    else row.other += n
  }

  for (const r of durationRows) {
    const row = ensure(r.provider)
    row.avgDurationMs = r.avgDurationMs != null ? Math.round(Number(r.avgDurationMs)) : null
    row.totalDurationMs = r.totalDurationMs != null ? Number(r.totalDurationMs) : 0
  }

  const typeMap = new Map<string, Map<string, { runs: number, succeeded: number, failed: number }>>()
  for (const r of typeRows) {
    const byType = typeMap.get(r.provider) || new Map()
    const cur = byType.get(r.taskType) || { runs: 0, succeeded: 0, failed: 0 }
    const n = Number(r.c) || 0
    cur.runs += n
    if (r.status === 'succeeded') cur.succeeded += n
    if (r.status === 'failed') cur.failed += n
    byType.set(r.taskType, cur)
    typeMap.set(r.provider, byType)
  }

  for (const [provider, byType] of typeMap) {
    const row = ensure(provider)
    row.byTaskType = [...byType.entries()]
      .map(([taskType, v]) => ({ taskType, ...v }))
      .sort((a, b) => b.runs - a.runs)
  }

  for (const row of map.values()) {
    const decided = row.succeeded + row.failed
    row.successRate = decided > 0 ? Math.round((row.succeeded / decided) * 1000) / 10 : null
  }

  const preferred = ['cursor', 'claude', 'codex', 'gemini', 'copilot', 'unassigned']
  return [...map.values()].sort((a, b) => {
    const ai = preferred.indexOf(a.provider)
    const bi = preferred.indexOf(b.provider)
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    return b.runs - a.runs
  })
}

export type TaskTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  totalCostUsd: number | null
}

function asNonNegInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/** Normalize Cursor (camelCase) / Claude (snake_case) usage stored on result_metadata. */
export function extractTaskTokenUsage(resultMetadata: unknown): TaskTokenUsage | null {
  if (!resultMetadata || typeof resultMetadata !== 'object') return null
  const root = resultMetadata as Record<string, unknown>
  const usage = (root.usage && typeof root.usage === 'object')
    ? root.usage as Record<string, unknown>
    : root
  const inputTokens = asNonNegInt(usage.inputTokens ?? usage.input_tokens)
  const outputTokens = asNonNegInt(usage.outputTokens ?? usage.output_tokens)
  const cacheReadTokens = asNonNegInt(
    usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens,
  )
  const cacheWriteTokens = asNonNegInt(
    usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? usage.cache_write_tokens,
  )
  const totalTokens = asNonNegInt(usage.totalTokens ?? usage.total_tokens)
    || (inputTokens + outputTokens)
  const costRaw = usage.totalCostUsd ?? usage.total_cost_usd
  const totalCostUsd = typeof costRaw === 'number' && Number.isFinite(costRaw) ? costRaw : null

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && totalTokens === 0) {
    return null
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    totalCostUsd,
  }
}

const FINISHED_STATUSES = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const

/** Parse windowHours query: omit/`all` → all finished runs; otherwise clamp 1–168. */
export function parseFinishedTaskRunsWindowHours(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return 24
  return Math.min(168, Math.max(1, n))
}

function mapFinishedTaskRun(run: typeof taskRuns.$inferSelect, repositoryName: string | null) {
  const usage = extractTaskTokenUsage(run.resultMetadata)
  return {
    id: run.id,
    title: run.title,
    externalId: run.externalId,
    externalUrl: run.externalUrl,
    taskType: run.taskType,
    forgeType: run.forgeType,
    provider: run.provider,
    status: run.status,
    repositoryName,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    errorSummary: run.errorSummary,
    branch: typeof run.resultMetadata?.branch === 'string' ? run.resultMetadata.branch : null,
    usage,
  }
}

/** Finished task runs for dashboards and usage page (status + token usage). */
export async function listFinishedTaskRuns(opts: {
  /** Hours to look back; omit or pass null for all finished runs. */
  windowHours?: number | null
  limit?: number
  page?: number
  pageSize?: number
} = {}) {
  const db = getDb()
  const windowHours = opts.windowHours == null
    ? null
    : Math.min(168, Math.max(1, opts.windowHours))
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? opts.limit ?? 50))
  const offset = (page - 1) * pageSize

  const conditions = [
    inArray(taskRuns.status, [...FINISHED_STATUSES]),
  ]
  if (windowHours != null) {
    conditions.push(gte(taskRuns.finishedAt, new Date(Date.now() - windowHours * 3600 * 1000)))
  }
  const where = and(...conditions)

  const rows = await db.select({
    run: taskRuns,
    repositoryName: repositories.name,
  }).from(taskRuns)
    .leftJoin(repositories, eq(taskRuns.repositoryId, repositories.id))
    .where(where)
    .orderBy(desc(taskRuns.finishedAt))
    .limit(pageSize)
    .offset(offset)

  const [totalRow] = await db.select({ c: count() }).from(taskRuns).where(where)

  return {
    items: rows.map(({ run, repositoryName }) => mapFinishedTaskRun(run, repositoryName)),
    page,
    pageSize,
    total: totalRow?.c ?? 0,
    windowHours,
  }
}
