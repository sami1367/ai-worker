import { handleApi, clientIpHash } from '#utils/api'
import { logout } from '#services/auth'
import { clearSessionCookie, readSessionId, requireUser } from '#utils/session'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event).catch(() => null)
  const sessionId = readSessionId(event)
  await logout(sessionId, user ? { id: user.id, username: user.username } : undefined, clientIpHash(event))
  clearSessionCookie(event)
  return { ok: true }
}))
