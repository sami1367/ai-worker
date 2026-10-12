import type { H3Event } from 'h3'
import { deleteCookie, getCookie, setCookie } from 'h3'
import { AppError } from './errors'
import { getSessionUser } from '#services/auth'

export const SESSION_COOKIE = 'aiw_session'

export function setSessionCookie(event: H3Event, sessionId: string, expiresAt: Date) {
  const secure = process.env.NODE_ENV === 'production'
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  setCookie(event, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
    maxAge,
  })
}

export function clearSessionCookie(event: H3Event) {
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
}

export function readSessionId(event: H3Event): string | undefined {
  return getCookie(event, SESSION_COOKIE)
}

export async function requireUser(event: H3Event) {
  const sessionId = readSessionId(event)
  const user = await getSessionUser(sessionId)
  if (!user) {
    throw new AppError(401, 'Authentication required', 'unauthenticated')
  }
  return user
}

export async function requireAdmin(event: H3Event) {
  const user = await requireUser(event)
  if (user.role !== 'admin') {
    throw new AppError(403, 'Administrator role required', 'forbidden')
  }
  return user
}
