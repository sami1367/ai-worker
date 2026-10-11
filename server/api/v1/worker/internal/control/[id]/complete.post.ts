import { readBody, getHeader } from 'h3'
import { z } from 'zod'
import { handleApi } from '#utils/api'
import { completeControlRequest } from '#services/worker'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'

const schema = z.object({
  ok: z.boolean(),
  result: z.record(z.unknown()).default({}),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }
  const body = schema.parse(await readBody(event))
  return completeControlRequest(getRouterParam(event, 'id')!, body.ok, body.result)
}))
