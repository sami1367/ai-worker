import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  return { user: { id: user.id, username: user.username, role: user.role } }
}))
