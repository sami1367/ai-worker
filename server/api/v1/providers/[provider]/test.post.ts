import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { testProvider } from '#services/providers'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const provider = getRouterParam(event, 'provider')!
  return testProvider(provider)
}))
