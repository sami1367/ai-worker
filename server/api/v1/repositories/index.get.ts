import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listRepositories } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const q = getQuery(event)
  return listRepositories({
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 20,
    q: q.q ? String(q.q) : undefined,
    forgeType: q.forgeType === 'github' || q.forgeType === 'gitlab' ? q.forgeType : undefined,
    enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
    includeArchived: q.includeArchived === 'true',
  })
}))
