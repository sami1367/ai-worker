import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { testConnection } from '#services/connections'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  return testConnection(id, { id: user.id, username: user.username })
}))
