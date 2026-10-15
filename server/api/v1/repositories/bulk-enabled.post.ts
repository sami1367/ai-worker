import { readBody } from 'h3'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { bulkSetEnabledSchema, setRepositoriesEnabledBulk } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const body = bulkSetEnabledSchema.parse(await readBody(event))
  return setRepositoriesEnabledBulk(body, { id: user.id, username: user.username }, clientIpHash(event))
}))
