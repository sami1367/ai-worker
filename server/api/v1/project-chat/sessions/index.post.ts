import { z } from 'zod'
import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { AppError } from '#utils/errors'
import { createProjectChat } from '#services/project-chat'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  const parsed = z.object({ repositoryId: z.string().uuid() }).safeParse(await readBody(event))
  if (!parsed.success) throw new AppError(400, 'Repository is required', 'validation_error')
  return { session: await createProjectChat(parsed.data.repositoryId, user) }
}))
