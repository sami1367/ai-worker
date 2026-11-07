import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { createMicroserviceChat } from '#services/microservice-chat'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return createMicroserviceChat(getRouterParam(event, 'groupId')!, user.id)
}))
