import { readBody } from 'h3'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { createRepository, createRepositorySchema } from '#services/repositories'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const body = createRepositorySchema.parse(await readBody(event))
  if (body.allowHostPath && user.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Host path mode requires admin' })
  }
  return createRepository(body, { id: user.id, username: user.username }, clientIpHash(event))
}))
