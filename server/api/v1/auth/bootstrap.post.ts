import { readBody } from 'h3'
import { z } from 'zod'
import { handleApi, clientIpHash } from '#utils/api'
import { bootstrapAdmin } from '#services/auth'
import { setSessionCookie } from '#utils/session'
import { login } from '#services/auth'
import { isInsecureSecret, SECRET_MIN_LENGTHS } from '#utils/app-secrets'

const schema = z.object({
  username: z.string().min(3).max(64).optional(),
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
  bootstrapSecret: z.string().min(1),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const body = schema.parse(await readBody(event))
  const config = useRuntimeConfig()
  const username = body.username || config.initialAdminUsername
  if (!username) {
    throw createError({ statusCode: 400, statusMessage: 'Username required' })
  }
  const expected = config.initialAdminBootstrapSecret || process.env.INITIAL_ADMIN_BOOTSTRAP_SECRET || ''
  if (isInsecureSecret(expected, SECRET_MIN_LENGTHS.INITIAL_ADMIN_BOOTSTRAP_SECRET)) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Bootstrap secret is not configured securely. Run scripts/generate-env.sh and restart.',
    })
  }
  await bootstrapAdmin({
    username,
    email: body.email,
    password: body.password,
    bootstrapSecret: body.bootstrapSecret,
    expectedSecret: expected,
    ipHash: clientIpHash(event),
  })
  const session = await login({
    username,
    password: body.password,
    ipHash: clientIpHash(event),
    userAgent: getHeader(event, 'user-agent') || undefined,
  })
  setSessionCookie(event, session.sessionId, session.expiresAt)
  return { user: session.user }
}))
