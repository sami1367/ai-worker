import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listMicroserviceChats } from '#services/microservice-chat'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return listMicroserviceChats(getRouterParam(event, 'groupId')!, user.id)
}))
