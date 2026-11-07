import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getMicroserviceGroup } from '#services/microservice-groups'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return getMicroserviceGroup(getRouterParam(event, 'groupId')!, user.id)
}))
