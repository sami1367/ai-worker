import { sendRedirect, getQuery } from 'h3'
import { completeOAuthCallback } from '#services/connections'
import { createErrorResponse } from '#utils/errors'
import { newCorrelationId } from '#utils/crypto'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  try {
    const result = await completeOAuthCallback({
      provider: 'github',
      code: q.code ? String(q.code) : null,
      state: q.state ? String(q.state) : null,
      error: q.error ? String(q.error) : null,
      errorDescription: q.error_description ? String(q.error_description) : null,
    })
    const dest = `${result.redirectPath}${result.redirectPath.includes('?') ? '&' : '?'}connected=${result.connection.id}`
    return sendRedirect(event, dest, 302)
  } catch (err) {
    const mapped = createErrorResponse(err, newCorrelationId())
    const msg = encodeURIComponent(mapped.body.error.message)
    return sendRedirect(event, `/connections?error=${msg}`, 302)
  }
})
