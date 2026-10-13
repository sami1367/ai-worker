import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { listPrompts } from '#services/prompts'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const query = getQuery(event)
  const includeContent = query.includeContent === '1' || query.includeContent === 'true'
  return { items: await listPrompts({ includeContent }) }
}))
