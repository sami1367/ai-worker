import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import { safeEqual } from './crypto'
import { AppError } from './errors'
export function requireChatWorkWorker(event: H3Event) {
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(getHeader(event, 'x-worker-token') || '', expected)) throw new AppError(401, 'Unauthorized', 'unauthorized')
}
