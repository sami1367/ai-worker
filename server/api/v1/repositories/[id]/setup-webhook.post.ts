import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { setupWebhookForRepository } from '#services/webhooks'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')!
  return setupWebhookForRepository(
    id,
    { id: user.id, username: user.username },
    clientIpHash(event),
  )
}))
