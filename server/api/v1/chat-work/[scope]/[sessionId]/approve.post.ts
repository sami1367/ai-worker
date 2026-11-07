import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { chatScopeSchema } from '#shared/chat-work'
import { AppError } from '#utils/errors'
import { z } from 'zod'
import { approveChatWork } from '#services/chat-work'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  const parsedScope = chatScopeSchema.safeParse(getRouterParam(event, 'scope'))
  if (!parsedScope.success) throw new AppError(400, 'Invalid chat scope', 'validation_error')
  const scope = parsedScope.data
  const id = getRouterParam(event, 'sessionId')!
  const body = z.object({ revision: z.number().int().positive() }).safeParse(await readBody(event))
  if (!body.success) throw new AppError(400, 'Plan revision is required', 'validation_error')
  return approveChatWork(scope, id, user, body.data.revision)
}))
