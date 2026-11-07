import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { deleteChatConversation } from '#services/chat-conversations'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return deleteChatConversation('project', getRouterParam(event, 'id')!, user.id)
}))
