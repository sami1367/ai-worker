import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getPlanningSession } from '#services/task-planning'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  return getPlanningSession(id)
}))
