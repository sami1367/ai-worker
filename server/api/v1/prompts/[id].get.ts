import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { AppError } from '#utils/errors'
import { getPromptById } from '#services/prompts'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(400, 'Missing id', 'validation_error')
  return getPromptById(id)
}))
