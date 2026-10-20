import { z } from 'zod'
import { handleApi, clientIpHash } from '#utils/api'
import { requireUser } from '#utils/session'
import { createPlanningSession, openPlanningSessionForRepo } from '#services/task-planning'
import { AppError } from '#utils/errors'

const bodySchema = z.object({
  repositoryId: z.string().uuid(),
  forceNew: z.boolean().optional(),
  resume: z.boolean().optional().default(true),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw new AppError(400, 'Invalid body', 'validation_error')
  }
  const ipHash = clientIpHash(event)
  const actor = { id: user.id, username: user.username }

  if (parsed.data.resume !== false && !parsed.data.forceNew) {
    return {
      session: await openPlanningSessionForRepo(
        parsed.data.repositoryId,
        actor,
        ipHash,
        { forceNew: false },
      ),
    }
  }

  return {
    session: await createPlanningSession(parsed.data.repositoryId, actor, ipHash),
  }
}))
