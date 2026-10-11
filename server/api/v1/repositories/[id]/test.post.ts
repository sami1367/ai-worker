import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { testRepositoryConnection } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  return testRepositoryConnection(id)
}))
