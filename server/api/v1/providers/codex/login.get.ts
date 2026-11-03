import { handleApi } from '#utils/api'
import { requireAdmin } from '#utils/session'
import { codexLoginState, codexChatgptConnected } from '#services/codex-auth'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireAdmin(event)
  return { ...codexLoginState(user.id), connected: codexChatgptConnected() }
}))
