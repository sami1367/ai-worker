import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getTaskRun } from '#services/tasks'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  return getTaskRun(getRouterParam(event, 'id')!)
}))
