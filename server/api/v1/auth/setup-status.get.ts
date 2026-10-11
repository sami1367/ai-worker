import { handleApi } from '#utils/api'
import { setupStatus } from '#services/auth'

export default defineEventHandler((event) => handleApi(event, async () => {
  return setupStatus()
}))
