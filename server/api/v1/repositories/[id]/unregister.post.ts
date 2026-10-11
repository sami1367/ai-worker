import { readBody } from 'h3'
import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { unregisterRepository } from '#services/registration'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  const body = await readBody(event).catch(() => ({})) as { deleteWorkspace?: boolean }
  return unregisterRepository(id, { id: user.id, username: user.username }, {
    deleteWorkspace: Boolean(body?.deleteWorkspace),
  })
}))
