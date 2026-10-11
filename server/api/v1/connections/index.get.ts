import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listConnections, oauthStatus } from '#services/connections'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const connections = await listConnections()
  const oauth = await oauthStatus()
  return { ...connections, oauth }
}))
