import { z } from 'zod'
import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { AppError } from '#utils/errors'
import { listProjectChats } from '#services/project-chat'
export default defineEventHandler(event => handleApi(event, async () => {
  const user = await requireUser(event)
  const parsed = z.string().uuid().safeParse(getQuery(event).repositoryId)
  if (!parsed.success) throw new AppError(400, 'Repository is required', 'validation_error')
  return listProjectChats(parsed.data, user.id)
}))
