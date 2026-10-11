import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listTaskRuns } from '#services/tasks'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const q = getQuery(event)
  return listTaskRuns({
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 20,
    q: q.q ? String(q.q) : undefined,
    repositoryId: q.repositoryId ? String(q.repositoryId) : undefined,
    provider: q.provider ? String(q.provider) : undefined,
    taskType: q.taskType ? String(q.taskType) : undefined,
    status: q.status ? String(q.status) : undefined,
    from: q.from ? new Date(String(q.from)) : undefined,
    to: q.to ? new Date(String(q.to)) : undefined,
  })
}))
