import { getHeader } from 'h3'
import { handleApi } from '#utils/api'
import { claimControlRequests } from '#services/worker'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }
  const items = await claimControlRequests(5)
  return { items }
}))
