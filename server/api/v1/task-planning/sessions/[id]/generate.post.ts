import { z } from 'zod'
import { handleApi, clientIpHash } from '#utils/api'
import { requireUser } from '#utils/session'
import { generatePlanningTasks } from '#services/task-planning'
import { AppError } from '#utils/errors'

const bodySchema = z.object({
  regenerate: z.boolean().optional(),
}).optional()

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const parsed = bodySchema.safeParse(await readBody(event).catch(() => ({})))
  if (!parsed.success) {
    throw new AppError(400, 'Invalid body', 'validation_error')
  }
  const session = await generatePlanningTasks(
    id,
    { id: user.id, username: user.username },
    clientIpHash(event),
    { regenerate: Boolean(parsed.data?.regenerate) },
  )
  return { session }
}))
