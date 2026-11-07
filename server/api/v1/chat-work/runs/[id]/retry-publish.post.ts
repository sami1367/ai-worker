import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { retryChatWorkPublish } from '#services/chat-work'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return retryChatWorkPublish(getRouterParam(event, 'id')!, user.id)
}))
