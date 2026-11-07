import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { chatScopeSchema } from '#shared/chat-work'
import { AppError } from '#utils/errors'
import { generateChatWork } from '#services/chat-work'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  const parsedScope = chatScopeSchema.safeParse(getRouterParam(event, 'scope'))
  if (!parsedScope.success) throw new AppError(400, 'Invalid chat scope', 'validation_error')
  const scope = parsedScope.data
  const id = getRouterParam(event, 'sessionId')!
  return generateChatWork(scope, id, user.id)
}))
