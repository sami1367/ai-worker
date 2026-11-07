import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getProviderPlanSnapshots } from '#services/provider-plans'

export default defineEventHandler(event => handleApi(event, async () => {
  await requireUser(event)
  return getProviderPlanSnapshots(true)
}))
