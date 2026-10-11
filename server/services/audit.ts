import { desc, eq, sql } from 'drizzle-orm'
import { auditLogs } from '#db/schema'
import { getDb } from '#utils/db'

export interface AuditEntry {
  actorUserId?: string | null
  actorUsername?: string | null
  action: string
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  ipHash?: string
}

export async function writeAudit(entry: AuditEntry) {
  const db = getDb()
  // Never persist secret-looking keys
  const metadata = scrubSecrets(entry.metadata || {})
  await db.insert(auditLogs).values({
    actorUserId: entry.actorUserId ?? null,
    actorUsername: entry.actorUsername ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata,
    ipHash: entry.ipHash,
  })
}

function scrubSecrets(meta: Record<string, unknown>): Record<string, unknown> {
  const blocked = /password|token|secret|authorization|cookie|api[_-]?key/i
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (blocked.test(k)) {
      out[k] = '[redacted]'
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrubSecrets(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

export async function listAuditLogs(opts: {
  page: number
  pageSize: number
  action?: string
}) {
  const db = getDb()
  const page = Math.max(1, opts.page)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize))
  const offset = (page - 1) * pageSize

  const rows = opts.action
    ? await db.select().from(auditLogs).where(eq(auditLogs.action, opts.action))
      .orderBy(desc(auditLogs.createdAt)).limit(pageSize).offset(offset)
    : await db.select().from(auditLogs)
      .orderBy(desc(auditLogs.createdAt)).limit(pageSize).offset(offset)

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs)

  return {
    items: rows,
    page,
    pageSize,
    total: count,
  }
}
