import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { runDiscoverySyncAll } from '#services/discovery-scheduler'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  return runDiscoverySyncAll('manual')
}))
