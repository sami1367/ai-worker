import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { AppError } from '#utils/errors'
import { resetPromptToSeed } from '#services/prompts'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(400, 'Missing id', 'validation_error')
  return resetPromptToSeed(id, { id: user.id, username: user.username }, clientIpHash(event))
}))
