import { readBody } from 'h3'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { updateRepository, updateRepositorySchema } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')!
  const body = updateRepositorySchema.parse(await readBody(event))
  return updateRepository(id, body, { id: user.id, username: user.username }, clientIpHash(event))
}))
