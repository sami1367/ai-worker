import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { syncConnectionRepositories } from '#services/discovery'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  return syncConnectionRepositories(id, {
    actorUserId: user.id,
    actorUsername: user.username,
  })
}))
