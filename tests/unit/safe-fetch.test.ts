import { describe, expect, it } from 'vitest'
import { normalizeInstanceUrl } from '../../server/utils/safe-fetch'
import { AppError } from '../../server/utils/errors'

describe('normalizeInstanceUrl / SSRF policy', () => {
  it('normalizes GitLab.com HTTPS URLs', () => {
    expect(normalizeInstanceUrl('https://gitlab.com/')).toBe('https://gitlab.com')
    expect(normalizeInstanceUrl('gitlab.com')).toBe('https://gitlab.com')
  })

  it('rejects localhost and private IPs by default', () => {
    expect(() => normalizeInstanceUrl('https://localhost')).toThrow(AppError)
    expect(() => normalizeInstanceUrl('https://127.0.0.1')).toThrow(AppError)
    expect(() => normalizeInstanceUrl('https://192.168.1.10')).toThrow(AppError)
    expect(() => normalizeInstanceUrl('https://169.254.169.254')).toThrow(AppError)
  })

  it('rejects HTTP unless explicitly allowlisted', () => {
    const prevHttp = process.env.GITLAB_ALLOW_HTTP
    const prevHosts = process.env.GITLAB_TRUSTED_HOSTS
    process.env.GITLAB_ALLOW_HTTP = 'false'
    expect(() => normalizeInstanceUrl('http://gitlab.example.com')).toThrow(AppError)

    process.env.GITLAB_ALLOW_HTTP = 'true'
    process.env.GITLAB_TRUSTED_HOSTS = 'gitlab.internal'
    expect(normalizeInstanceUrl('http://gitlab.internal', {
      allowHttp: true,
      trustedHosts: ['gitlab.internal'],
    })).toBe('http://gitlab.internal')

    process.env.GITLAB_ALLOW_HTTP = prevHttp
    process.env.GITLAB_TRUSTED_HOSTS = prevHosts
  })

  it('rejects credentials and paths in server URL', () => {
    expect(() => normalizeInstanceUrl('https://user:pass@gitlab.com')).toThrow(AppError)
    expect(() => normalizeInstanceUrl('https://gitlab.com/groups')).toThrow(AppError)
  })

  it('allows trusted private IPs when configured', () => {
    expect(normalizeInstanceUrl('https://10.0.0.5', {
      trustedHosts: ['10.0.0.5'],
    })).toBe('https://10.0.0.5')
  })
})
