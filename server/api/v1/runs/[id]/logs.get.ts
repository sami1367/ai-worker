import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getTaskLogTail } from '#services/tasks'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const q = getQuery(event)
  const maxBytes = Math.min(1_000_000, Math.max(1024, Number(q.maxBytes) || 256_000))
  return getTaskLogTail(getRouterParam(event, 'id')!, maxBytes)
}))
