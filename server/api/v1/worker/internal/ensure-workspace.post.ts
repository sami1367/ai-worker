import { getHeader, readBody } from 'h3'
import { z } from 'zod'
import { handleApi } from '#utils/api'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'
import { ensureWorkspaceForWorker } from '#services/workspace-manager'

const bodySchema = z.object({
  path: z.string().min(1).max(1024).optional(),
  name: z.string().min(1).max(128).optional(),
  fullName: z.string().min(1).max(256).optional(),
  forgeType: z.enum(['github', 'gitlab']).optional(),
}).refine((v) => Boolean(v.path || v.name || v.fullName), { message: 'path, name, or fullName required' })

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }
  const body = bodySchema.parse(await readBody(event))
  return ensureWorkspaceForWorker(body)
}))
