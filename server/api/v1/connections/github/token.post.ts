import { readBody } from 'h3'
import { handleApi, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { connectGitHubWithToken, githubTokenConnectionSchema } from '#services/connections'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const body = githubTokenConnectionSchema.parse(await readBody(event))
  return connectGitHubWithToken(body, { id: user.id, username: user.username })
}))
