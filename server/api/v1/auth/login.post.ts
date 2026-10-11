import { readBody, getHeader } from 'h3'
import { z } from 'zod'
import { handleApi, clientIpHash } from '#utils/api'
import { login } from '#services/auth'
import { setSessionCookie } from '#utils/session'

const schema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const body = schema.parse(await readBody(event))
  const session = await login({
    username: body.username,
    password: body.password,
    ipHash: clientIpHash(event),
    userAgent: getHeader(event, 'user-agent') || undefined,
  })
  setSessionCookie(event, session.sessionId, session.expiresAt)
  return { user: session.user }
}))
