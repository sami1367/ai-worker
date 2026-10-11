import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { listAuditLogs } from '#services/audit'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const q = getQuery(event)
  return listAuditLogs({
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
    action: q.action ? String(q.action) : undefined,
  })
}))
