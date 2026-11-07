import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listChatWorkRuns } from '#services/chat-work'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return listChatWorkRuns(user.id)
}))
