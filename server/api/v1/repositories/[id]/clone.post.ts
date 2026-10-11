import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { queueWorkspaceOperation } from '#services/workspace-manager'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  return queueWorkspaceOperation({
    repositoryId: id,
    operationType: 'clone',
    actor: { id: user.id, username: user.username },
  })
}))
