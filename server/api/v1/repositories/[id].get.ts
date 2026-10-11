import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getRepository, repositoryRecentRuns } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const repo = await getRepository(id)
  const recentRuns = await repositoryRecentRuns(id, 15)
  return { ...repo, recentRuns }
}))
