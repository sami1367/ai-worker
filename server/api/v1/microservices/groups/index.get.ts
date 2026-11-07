import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listMicroserviceGroups } from '#services/microservice-groups'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  return listMicroserviceGroups(user.id)
}))
