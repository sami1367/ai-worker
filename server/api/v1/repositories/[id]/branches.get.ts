import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listRepositoryBranches } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  return listRepositoryBranches(id)
}))
