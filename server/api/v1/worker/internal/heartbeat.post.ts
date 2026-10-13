import { readBody, getHeader } from 'h3'
import { z } from 'zod'
import { handleApi } from '#utils/api'
import { workerHeartbeat } from '#services/worker'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'

const activeTaskSchema = z.object({
  repositoryName: z.string().optional(),
  taskType: z.string().optional(),
  externalId: z.string().optional(),
  title: z.string().optional(),
  pid: z.number().int().optional(),
  startedAt: z.string().optional(),
})

const schema = z.object({
  status: z.enum(['starting', 'running', 'stopping', 'stopped', 'error']),
  configVersionLoaded: z.number().int().optional(),
  hostname: z.string().optional(),
  pid: z.number().int().optional(),
  version: z.string().optional(),
  providerAvailability: z.record(z.unknown()).optional(),
  activeTaskCount: z.number().int().optional(),
  activeTasks: z.array(activeTaskSchema).optional(),
  pollSucceeded: z.boolean().optional(),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }
  const body = schema.parse(await readBody(event))
  await workerHeartbeat(body)
  return { ok: true }
}))
