import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getSettings } from '#services/settings'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  return getSettings()
}))
