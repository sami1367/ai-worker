import { describe, expect, it } from 'vitest'
import { codeChallengeS256, newCodeVerifier, newOAuthState } from '../../server/services/pkce'

describe('pkce', () => {
  it('generates unique verifiers and states', () => {
    const a = newCodeVerifier()
    const b = newCodeVerifier()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(20)
    expect(newOAuthState()).not.toBe(newOAuthState())
  })

  it('creates S256 challenges', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    // RFC 7636 appendix B
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
