import type { H3Event } from 'h3'
import { createError, getHeader, getRequestIP } from 'h3'
import { AppError, createErrorResponse } from './errors'
import { hashIdentifier, newCorrelationId } from './crypto'

export function correlationId(event: H3Event): string {
  const existing = getHeader(event, 'x-correlation-id')
  const id = existing && /^[a-zA-Z0-9-]{8,64}$/.test(existing) ? existing : newCorrelationId()
  event.node.res.setHeader('x-correlation-id', id)
  return id
}

export function clientIpHash(event: H3Event): string {
  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  return hashIdentifier(ip)
}

export async function handleApi<T>(event: H3Event, fn: () => Promise<T>): Promise<T> {
  const cid = correlationId(event)
  try {
    return await fn()
  } catch (err) {
    const mapped = createErrorResponse(err, cid)
    throw createError({
      statusCode: mapped.statusCode,
      statusMessage: mapped.body.error.message,
      data: mapped.body.error,
    })
  }
}

export function requireRole(role: 'admin' | 'operator', userRole: string) {
  if (userRole === 'admin') return
  if (role === 'operator' && userRole === 'operator') return
  throw new AppError(403, 'Insufficient permissions', 'forbidden')
}
