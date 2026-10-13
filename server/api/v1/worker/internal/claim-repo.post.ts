import { getHeader, readBody } from 'h3'
import { handleApi } from '#utils/api'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'
import { claimRepoSchema, tryClaimRepo } from '#services/repo-claims'

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }

  const body = claimRepoSchema.parse(await readBody(event))
  return tryClaimRepo(body)
}))
