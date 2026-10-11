import { readBody } from 'h3'
import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { startGitLabConnectionSchema, startGitLabOAuth } from '#services/connections'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const body = startGitLabConnectionSchema.parse(await readBody(event) || {})
  return startGitLabOAuth(body, { id: user.id, username: user.username })
}))
