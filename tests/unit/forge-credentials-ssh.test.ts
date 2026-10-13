import { describe, expect, it } from 'vitest'
import {
  httpsRemoteToSshUrl,
  isHttpGitDisabledError,
} from '../../server/services/forge-credentials'

describe('httpsRemoteToSshUrl', () => {
  it('converts https remotes to git@ form', () => {
    expect(httpsRemoteToSshUrl('https://git.example.com/group/api.git'))
      .toBe('git@git.example.com:group/api.git')
    expect(httpsRemoteToSshUrl('https://git.example.com/group/api'))
      .toBe('git@git.example.com:group/api.git')
  })

  it('passes through existing SSH remotes', () => {
    expect(httpsRemoteToSshUrl('git@git.example.com:group/api.git'))
      .toBe('git@git.example.com:group/api.git')
    expect(httpsRemoteToSshUrl('ssh://git@git.example.com/group/api.git'))
      .toBe('git@git.example.com:group/api.git')
  })
})

describe('isHttpGitDisabledError', () => {
  it('detects GitLab HTTP-disabled clone failures', () => {
    expect(isHttpGitDisabledError(
      "remote: Git access over HTTP is not allowed\nfatal: unable to access 'https://git.example.com/a.git/': The requested URL returned error: 403",
    )).toBe(true)
    expect(isHttpGitDisabledError('HTTP access for git is disabled')).toBe(true)
    expect(isHttpGitDisabledError('Authentication failed')).toBe(false)
  })
})
