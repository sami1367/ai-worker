import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getConnection } from '#services/connections'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  const { public: connection } = await getConnection(id)
  return connection
}))
