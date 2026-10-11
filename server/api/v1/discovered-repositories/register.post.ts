import { readBody } from 'h3'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { registerDiscoveredRepositories, registerDiscoveredSchema } from '#services/registration'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const body = registerDiscoveredSchema.parse(await readBody(event))
  return registerDiscoveredRepositories(body, { id: user.id, username: user.username }, clientIpHash(event))
}))
