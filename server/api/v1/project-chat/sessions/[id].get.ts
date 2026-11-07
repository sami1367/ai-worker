import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getProjectChat } from '#services/project-chat'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return getProjectChat(getRouterParam(event, 'id')!, user.id)
}))
