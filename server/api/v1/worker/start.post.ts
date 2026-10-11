import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { requestWorkerControl } from '#services/worker'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  return requestWorkerControl('start', { id: user.id, username: user.username }, {}, clientIpHash(event))
}))
