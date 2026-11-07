import { handleApi } from '#utils/api'
import { requireChatWorkWorker } from '#utils/chat-work-internal'
import { z } from 'zod'
import { AppError } from '#utils/errors'
import { heartbeatChatWork } from '#services/chat-work-execution'
export default defineEventHandler(event => handleApi(event, async () => {
  requireChatWorkWorker(event)
  const parsed = z.object({ leaseToken: z.string().uuid() }).safeParse(await readBody(event))
  if (!parsed.success) throw new AppError(400, 'Valid work lease is required', 'validation_error')
  return heartbeatChatWork(getRouterParam(event, 'id')!, parsed.data.leaseToken)
}))
