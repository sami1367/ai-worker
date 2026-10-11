import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listWorkspaceOperations } from '#services/workspace-manager'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  const items = await listWorkspaceOperations(id)
  return { items }
}))
