import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listProviders } from '#services/providers'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  return { items: await listProviders() }
}))
