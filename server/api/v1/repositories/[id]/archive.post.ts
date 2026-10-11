import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { archiveRepository } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')!
  return archiveRepository(id, { id: user.id, username: user.username }, clientIpHash(event))
}))
