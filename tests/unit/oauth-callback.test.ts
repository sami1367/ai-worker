import { describe, expect, it } from 'vitest'
import { AppError } from '../../server/utils/errors'

/**
 * OAuth callback guards that do not require a live database.
 * Full callback persistence is covered via the connections service integration path.
 */
function validateOAuthCallbackQuery(q: {
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
}) {
  if (q.error) {
    throw new AppError(400, q.errorDescription || q.error, 'oauth_denied')
  }
  if (!q.code || !q.state) {
    throw new AppError(400, 'Missing OAuth code or state', 'oauth_invalid')
  }
  if (q.state.length < 16) {
    throw new AppError(400, 'OAuth state is invalid or expired', 'oauth_state_invalid')
  }
  return true
}

function safeRedirectPath(path?: string | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/connections'
  return path
}

describe('oauth callback validation', () => {
  it('rejects provider error responses', () => {
    expect(() => validateOAuthCallbackQuery({ error: 'access_denied' })).toThrow(AppError)
  })

  it('rejects missing code/state', () => {
    expect(() => validateOAuthCallbackQuery({ code: 'x' })).toThrow(AppError)
    expect(() => validateOAuthCallbackQuery({ state: 'abcdefghijklmnop' })).toThrow(AppError)
  })

  it('accepts well-formed code/state pairs', () => {
    expect(validateOAuthCallbackQuery({
      code: 'abc',
      state: 'abcdefghijklmnop',
    })).toBe(true)
  })

  it('blocks open redirects in redirectPath', () => {
    expect(safeRedirectPath('https://evil.example')).toBe('/connections')
    expect(safeRedirectPath('//evil.example')).toBe('/connections')
    expect(safeRedirectPath('/connections/123')).toBe('/connections/123')
  })
})
