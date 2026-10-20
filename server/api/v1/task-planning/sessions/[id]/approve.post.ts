import { handleApi, clientIpHash } from '#utils/api'
import { requireUser } from '#utils/session'
import { approvePlanningTasks } from '#services/task-planning'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const session = await approvePlanningTasks(
    id,
    { id: user.id, username: user.username },
    clientIpHash(event),
  )
  return { session }
}))
