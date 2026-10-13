import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseGitHubWebhookEvent,
  parseGitLabWebhookEvent,
  verifyGitHubSignature,
  verifyGitLabToken,
  WEBHOOK_TRIGGER_LABELS,
} from '../../server/services/webhooks'

describe('webhook signature verification', () => {
  it('accepts a valid GitHub HMAC signature', () => {
    const secret = 'test-secret'
    const body = '{"action":"labeled"}'
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true)
  })

  it('rejects a bad GitHub signature', () => {
    expect(verifyGitHubSignature('{}', 'sha256=deadbeef', 'secret')).toBe(false)
    expect(verifyGitHubSignature('{}', undefined, 'secret')).toBe(false)
  })

  it('accepts a matching GitLab token', () => {
    expect(verifyGitLabToken('abc', 'abc')).toBe(true)
    expect(verifyGitLabToken('abc', 'xyz')).toBe(false)
    expect(verifyGitLabToken(undefined, 'abc')).toBe(false)
  })
})

describe('GitHub webhook parsing', () => {
  it('parses issue labeled with ai', () => {
    const parsed = parseGitHubWebhookEvent('issues', {
      action: 'labeled',
      label: { name: 'ai' },
      issue: { number: 12 },
      repository: { id: 99, full_name: 'acme/widget' },
    })
    expect(parsed.kind).toBe('issue')
    expect(parsed.action).toBe('labeled')
    expect(parsed.externalId).toBe('12')
    expect(parsed.repositoryFullName).toBe('acme/widget')
    expect(parsed.labels).toEqual(['ai'])
    expect(WEBHOOK_TRIGGER_LABELS.has('ai')).toBe(true)
  })

  it('parses pull_request labeled with ai-review', () => {
    const parsed = parseGitHubWebhookEvent('pull_request', {
      action: 'labeled',
      label: { name: 'ai-review' },
      pull_request: { number: 7 },
      repository: { id: 1, full_name: 'acme/widget' },
    })
    expect(parsed.kind).toBe('pull_request')
    expect(parsed.labels).toEqual(['ai-review'])
    expect(parsed.externalId).toBe('7')
  })

  it('treats ping as non-work', () => {
    const parsed = parseGitHubWebhookEvent('ping', { zen: 'keep it simple' })
    expect(parsed.kind).toBe('ping')
  })
})

describe('GitLab webhook parsing', () => {
  it('detects newly added ai label on issue update', () => {
    const parsed = parseGitLabWebhookEvent({
      object_kind: 'issue',
      object_attributes: { action: 'update', iid: 3 },
      project: { id: 55, path_with_namespace: 'group/proj' },
      changes: {
        labels: {
          previous: [{ title: 'bug' }],
          current: [{ title: 'bug' }, { title: 'ai' }],
        },
      },
    })
    expect(parsed.kind).toBe('issue')
    expect(parsed.externalId).toBe('3')
    expect(parsed.labels).toEqual(['ai'])
    expect(parsed.repositoryFullName).toBe('group/proj')
  })

  it('treats labels present on open as newly added', () => {
    const parsed = parseGitLabWebhookEvent({
      object_kind: 'merge_request',
      object_attributes: { action: 'open', iid: 9 },
      project: { id: 1, path_with_namespace: 'group/proj' },
      labels: [{ title: 'ai-review' }],
    })
    expect(parsed.kind).toBe('merge_request')
    expect(parsed.labels).toEqual(['ai-review'])
  })

  it('returns no labels when unchanged', () => {
    const parsed = parseGitLabWebhookEvent({
      object_kind: 'issue',
      object_attributes: { action: 'update', iid: 1 },
      project: { id: 1, path_with_namespace: 'g/p' },
      changes: {
        labels: {
          previous: [{ title: 'ai' }],
          current: [{ title: 'ai' }],
        },
      },
    })
    expect(parsed.labels).toEqual([])
  })
})
