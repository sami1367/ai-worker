import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { saveMicroserviceGroup } from '#services/microservice-groups'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return saveMicroserviceGroup(await readBody(event), user, getRouterParam(event, 'groupId')!)
}))
