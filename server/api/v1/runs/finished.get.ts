import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listFinishedTaskRuns, parseFinishedTaskRunsWindowHours } from '#services/tasks'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const q = getQuery(event)
  return listFinishedTaskRuns({
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 20,
    windowHours: parseFinishedTaskRunsWindowHours(q.windowHours),
  })
}))
