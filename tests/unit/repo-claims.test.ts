import { describe, expect, it } from 'vitest'
import { repoClaimLockKey } from '../../server/services/repo-claims'

describe('repoClaimLockKey', () => {
  it('normalizes forge + full name', () => {
    expect(repoClaimLockKey('github', 'Acme/Widget')).toBe('github:acme/widget')
    expect(repoClaimLockKey('gitlab', '/group/proj/')).toBe('gitlab:group/proj')
  })
})
