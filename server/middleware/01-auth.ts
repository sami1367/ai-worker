import { defineEventHandler, getRequestURL } from 'h3'
import { getSessionUser } from '#services/auth'
import { readSessionId } from '#utils/session'

const PUBLIC_PREFIXES = [
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/auth/login',
  '/api/v1/auth/setup-status',
  '/api/v1/auth/bootstrap',
  '/api/v1/worker/internal/',
  // Forge webhooks (HMAC / shared-token verified in handlers)
  '/api/v1/webhooks/',
  // OAuth provider redirects (CSRF protected by one-time state + PKCE)
  '/api/v1/connections/oauth/',
]

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) return

  // Attach user when session present (for all API routes)
  const sessionId = readSessionId(event)
  const user = await getSessionUser(sessionId).catch(() => null)
  event.context.user = user

  if (PUBLIC_PREFIXES.some((p) => url.pathname.startsWith(p))) return

  // Worker internal routes use a shared token, not session
  if (url.pathname.startsWith('/api/v1/worker/internal')) return

  if (url.pathname.startsWith('/api/v1/') && !user) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Authentication required',
      data: { code: 'unauthenticated', message: 'Authentication required' },
    })
  }
})
