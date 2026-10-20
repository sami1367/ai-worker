import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listPlanningSessions } from '#services/task-planning'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const query = getQuery(event)
  const repositoryId = typeof query.repositoryId === 'string' ? query.repositoryId : undefined
  return listPlanningSessions(repositoryId)
}))
