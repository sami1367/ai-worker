import { describe, expect, it } from 'vitest'
import { managedWorkspacePath, validateRemoteUrl } from '../../server/utils/paths'

describe('paths / remotes', () => {
  it('accepts safe remotes', () => {
    expect(validateRemoteUrl('https://github.com/org/repo.git').ok).toBe(true)
    expect(validateRemoteUrl('git@github.com:org/repo.git').ok).toBe(true)
  })

  it('rejects unsafe remotes', () => {
    expect(validateRemoteUrl('https://user:pass@github.com/org/repo').ok).toBe(false)
    expect(validateRemoteUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateRemoteUrl('../etc/passwd').ok).toBe(false)
  })

  it('prevents workspace escape', () => {
    process.env.WORKSPACE_ROOT = '/data/workspaces'
    expect(() => managedWorkspacePath('abc123')).not.toThrow()
    expect(() => managedWorkspacePath('../escape')).toThrow()
  })
})
