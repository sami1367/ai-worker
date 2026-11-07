import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { queueMicroservicePreparation } from '#services/microservice-groups'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return queueMicroservicePreparation(getRouterParam(event, 'groupId')!, user)
}))
