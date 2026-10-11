import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listDiscoveredRepositories } from '#services/discovery'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const q = getQuery(event)
  const provider = q.provider ? String(q.provider) : undefined
  return listDiscoveredRepositories({
    connectionId: q.connectionId ? String(q.connectionId) : undefined,
    provider: provider === 'github' || provider === 'gitlab' ? provider : undefined,
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
    q: q.q ? String(q.q) : undefined,
    visibility: q.visibility ? String(q.visibility) : undefined,
    registered: q.registered === undefined ? undefined : q.registered === 'true',
  })
}))
