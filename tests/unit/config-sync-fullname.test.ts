import { describe, expect, it } from 'vitest'
import { fullNameFromRemoteUrl } from '../../server/services/config-sync'

describe('fullNameFromRemoteUrl', () => {
  it('parses github https remotes', () => {
    expect(fullNameFromRemoteUrl('https://github.com/acme/api.git')).toBe('acme/api')
    expect(fullNameFromRemoteUrl('https://github.com/acme/api')).toBe('acme/api')
  })

  it('parses ssh remotes', () => {
    expect(fullNameFromRemoteUrl('git@github.com:acme/api.git')).toBe('acme/api')
    expect(fullNameFromRemoteUrl('ssh://git@gitlab.example.com/group/proj.git')).toBe('group/proj')
  })

  it('returns null for unusable urls', () => {
    expect(fullNameFromRemoteUrl('')).toBeNull()
    expect(fullNameFromRemoteUrl('not-a-url')).toBeNull()
  })
})
