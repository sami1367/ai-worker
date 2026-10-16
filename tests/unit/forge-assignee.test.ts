import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, '') || 'https://gitlab.com',
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { listGitHubAiIssues } from '../../server/services/forge-github'
import { listGitLabAiIssues } from '../../server/services/forge-gitlab'
import { isAssignedToForgeAccount } from '../../server/services/forge-types'

const mock = safeFetch as unknown as ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => text,
  }
}

describe('isAssignedToForgeAccount', () => {
  it('matches by login case-insensitively', () => {
    expect(isAssignedToForgeAccount(
      [{ id: '1', login: 'Sami1367' }],
      { accountId: '99', accountLogin: 'sami1367' },
    )).toBe(true)
  })

  it('matches by account id', () => {
    expect(isAssignedToForgeAccount(
      [{ id: '42', login: 'other' }],
      { accountId: '42', accountLogin: 'me' },
    )).toBe(true)
  })

  it('rejects unassigned and other assignees', () => {
    expect(isAssignedToForgeAccount([], { accountId: '1', accountLogin: 'me' })).toBe(false)
    expect(isAssignedToForgeAccount(undefined, { accountId: '1', accountLogin: 'me' })).toBe(false)
    expect(isAssignedToForgeAccount(
      [{ id: '9', login: 'someone-else' }],
      { accountId: '1', accountLogin: 'me' },
    )).toBe(false)
  })

  it('rejects when connection account identity is missing', () => {
    expect(isAssignedToForgeAccount(
      [{ id: '1', login: 'me' }],
      { accountId: null, accountLogin: null },
    )).toBe(false)
  })
})

describe('listGitHubAiIssues assignees', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses assignees from GitHub issue payloads', async () => {
    mock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (!u.includes('/issues?') || !u.includes('labels=ai') || u.includes('labels=ai-')) {
        return jsonResponse(200, [])
      }
      return jsonResponse(200, [
        {
          number: 36,
          title: 'mine',
          html_url: 'https://github.com/acme/app/issues/36',
          created_at: '2026-01-02T00:00:00Z',
          labels: [{ name: 'ai' }],
          assignees: [{ id: 28010102, login: 'sami1367' }],
          assignee: { id: 28010102, login: 'sami1367' },
        },
        {
          number: 37,
          title: 'unassigned',
          html_url: 'https://github.com/acme/app/issues/37',
          created_at: '2026-01-03T00:00:00Z',
          labels: [{ name: 'ai' }],
          assignees: [],
          assignee: null,
        },
      ])
    })

    const items = await listGitHubAiIssues('tok', 'acme/app')
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      externalId: '36',
      assignees: [{ id: '28010102', login: 'sami1367' }],
    })
    expect(items[1].assignees).toEqual([])
    expect(isAssignedToForgeAccount(items[0].assignees, {
      accountId: '28010102',
      accountLogin: 'sami1367',
    })).toBe(true)
    expect(isAssignedToForgeAccount(items[1].assignees, {
      accountId: '28010102',
      accountLogin: 'sami1367',
    })).toBe(false)
  })
})

describe('listGitLabAiIssues assignees', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses assignees from GitLab issue payloads', async () => {
    mock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (!u.includes('/issues?') || !u.includes('labels=ai') || u.includes('labels=ai-')) {
        return jsonResponse(200, [])
      }
      return jsonResponse(200, [
        {
          iid: 1,
          title: 'mine',
          web_url: 'https://gitlab.example/g/p/-/issues/1',
          created_at: '2026-01-02T00:00:00Z',
          labels: ['ai'],
          assignees: [{ id: 42, username: 'samirahimi' }],
          assignee: { id: 42, username: 'samirahimi' },
        },
      ])
    })

    const items = await listGitLabAiIssues('https://gitlab.example', 'tok', 'g/p')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      externalId: '1',
      assignees: [{ id: '42', login: 'samirahimi' }],
    })
    expect(isAssignedToForgeAccount(items[0].assignees, {
      accountId: '42',
      accountLogin: 'samirahimi',
    })).toBe(true)
  })
})
