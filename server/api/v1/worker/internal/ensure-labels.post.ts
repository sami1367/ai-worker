import { getHeader, readBody } from 'h3'
import { z } from 'zod'
import { handleApi } from '#utils/api'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'
import { ensureLabelsForWorker } from '#services/ai-labels'

const bodySchema = z.object({
  forgeType: z.enum(['github', 'gitlab']),
  fullName: z.string().min(1).max(512),
  name: z.string().min(1).max(128).optional(),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }
  const body = bodySchema.parse(await readBody(event))
  return ensureLabelsForWorker(body)
}))
