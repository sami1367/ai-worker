import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getDashboard } from '#services/dashboard'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const q = getQuery(event)
  const windowHours = Math.min(168, Math.max(1, Number(q.windowHours) || 24))
  return getDashboard(windowHours)
}))
