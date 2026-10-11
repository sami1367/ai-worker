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
