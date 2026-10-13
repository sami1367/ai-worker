import { describe, expect, it } from 'vitest'
import { redactSecrets, scrubObjectSecrets } from '../../server/utils/redact'

describe('redactSecrets', () => {
  it('redacts GitHub and GitLab tokens', () => {
    const input = 'token ghp_abcdefghijklmnopqrstuvwx and glpat-abcdefghijklmnopqrstuv'
    const out = redactSecrets(input)
    expect(out).not.toContain('ghp_')
    expect(out).not.toContain('glpat-')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts bearer headers and embedded basic auth', () => {
    const input = 'Authorization: Bearer abcdefghijklmnop https://user:secret@github.com/org/repo'
    const out = redactSecrets(input)
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).not.toContain('user:secret@')
  })

  it('redacts app secret assignments and database URLs', () => {
    const input = [
      'SECRET_ENCRYPTION_KEY=a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
      'WORKER_INTERNAL_TOKEN=wk_7f3a9c2e1b8d4f6a0e5c9b2d7a1f4e8c3b6d9e0a2f5c8',
      'DATABASE_URL=postgresql://aiworker:Aw7kP9mX2qR5vN8jL3hC6tY1wE4uS0bZ@db:5432/aiworker',
    ].join(' ')
    const out = redactSecrets(input)
    expect(out).not.toContain('a1b2c3d4e5f60718')
    expect(out).not.toContain('wk_7f3a9c2e1b8d4f')
    expect(out).not.toContain('Aw7kP9mX2qR5vN8j')
    expect(out).toContain('[REDACTED]')
  })

  it('scrubs secret-looking object keys', () => {
    const out = scrubObjectSecrets({
      access_token: 'super-secret',
      nested: { refresh_token: 'also-secret', ok: 'visible' },
    })
    expect(out.access_token).toBe('[REDACTED]')
    expect((out.nested as any).refresh_token).toBe('[REDACTED]')
    expect((out.nested as any).ok).toBe('visible')
  })
})
