import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getLiveTaskQueue } from '#services/task-queue'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const query = getQuery(event)
  const refresh = query.refresh === '1' || query.refresh === 'true'
  return getLiveTaskQueue({ refresh })
}))
