import { readBody } from 'h3'
import { z } from 'zod'
import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { AppError } from '#utils/errors'
import { updatePrompt } from '#services/prompts'

const schema = z.object({
  content: z.string().min(1).max(500_000),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(400, 'Missing id', 'validation_error')
  const body = schema.parse(await readBody(event))
  return updatePrompt(id, body, { id: user.id, username: user.username }, clientIpHash(event))
}))
