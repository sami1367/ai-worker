import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { setupWebhooksForConnection, webhookCallbackUrl } from '#services/webhooks'
import { getConnection } from '#services/connections'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')!
  const { public: conn } = await getConnection(id)
  const result = await setupWebhooksForConnection(
    id,
    { id: user.id, username: user.username },
    clientIpHash(event),
  )
  return {
    ...result,
    provider: conn.provider,
    webhookUrl: result.callbackUrl || webhookCallbackUrl(conn.provider, id),
  }
}))
