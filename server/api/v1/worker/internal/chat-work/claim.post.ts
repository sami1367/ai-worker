import { handleApi } from '#utils/api'
import { requireChatWorkWorker } from '#utils/chat-work-internal'
import { z } from 'zod'
import { AppError } from '#utils/errors'
import { claimChatWork } from '#services/chat-work-execution'
export default defineEventHandler(event => handleApi(event, async () => {
  requireChatWorkWorker(event)
  const parsed = z.object({ workerId: z.string().min(1).max(256) }).safeParse(await readBody(event))
  if (!parsed.success) throw new AppError(400, 'Worker ID is required', 'validation_error')
  return claimChatWork(parsed.data.workerId)
}))
