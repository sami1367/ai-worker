import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { z } from 'zod'
import { AppError } from '#utils/errors'
import { postMicroserviceChatMessage } from '#services/microservice-chat'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  const parsed = z.object({ content: z.string().trim().min(1).max(20_000) }).safeParse(await readBody(event))
  if (!parsed.success) throw new AppError(400, 'Message is required (maximum 20,000 characters)', 'validation_error')
  return postMicroserviceChatMessage(getRouterParam(event, 'groupId')!, getRouterParam(event, 'id')!, parsed.data.content, user.id)
}))
