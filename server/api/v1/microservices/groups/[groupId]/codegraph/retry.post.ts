import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { retryMicroserviceCodegraph } from '#services/microservice-groups'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return retryMicroserviceCodegraph(getRouterParam(event, 'groupId')!, user.id)
}))
