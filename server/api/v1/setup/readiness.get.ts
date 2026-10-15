import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getSetupReadiness } from '#services/setup-readiness'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  return getSetupReadiness()
}))
