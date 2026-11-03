import { handleApi } from '#utils/api'
import { requireAdmin } from '#utils/session'
import { startCodexLogin } from '#services/codex-auth'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireAdmin(event)
  return startCodexLogin(user.id)
}))
