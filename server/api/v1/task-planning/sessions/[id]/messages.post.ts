import { z } from 'zod'
import { handleApi, clientIpHash } from '#utils/api'
import { requireUser } from '#utils/session'
import { postPlanningMessage } from '#services/task-planning'
import { AppError } from '#utils/errors'

const bodySchema = z.object({
  content: z.string().min(1).max(20_000),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw new AppError(400, 'Message content is required', 'validation_error')
  }
  const session = await postPlanningMessage(
    id,
    parsed.data.content,
    { id: user.id, username: user.username },
    clientIpHash(event),
  )
  return { session }
}))
