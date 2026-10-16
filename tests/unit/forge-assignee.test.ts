import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, '') || 'https://gitlab.com',
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { listGitHubAiIssues, listGitHubAiPullRequests } from '../../server/services/forge-github'
import { listGitLabAiIssues, listGitLabAiMergeRequests } from '../../server/services/forge-gitlab'
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

describe('listGitHubAiPullRequests assignees', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses assignees and sorts oldest-first with deterministic id tie-break', async () => {
    mock.mockImplementation(async (url: string) => {
      const u = String(url)
      expect(u).toContain('sort=created')
      expect(u).toContain('direction=asc')
      return jsonResponse(200, [
        {
          number: 2,
          title: 'newer same second',
          html_url: 'https://github.com/acme/app/pull/2',
          created_at: '2026-01-01T00:00:00Z',
          labels: [{ name: 'ai-review' }],
          head: { ref: 'b' },
          assignees: [{ id: 1, login: 'me' }],
          assignee: { id: 1, login: 'me' },
        },
        {
          number: 1,
          title: 'older same second',
          html_url: 'https://github.com/acme/app/pull/1',
          created_at: '2026-01-01T00:00:00Z',
          labels: [{ name: 'ai-review' }],
          head: { ref: 'a' },
          assignees: [],
          assignee: null,
        },
      ])
    })

    const items = await listGitHubAiPullRequests('tok', 'acme/app')
    expect(items).toHaveLength(2)
    expect(items[0].externalId).toBe('1')
    expect(items[0].assignees).toEqual([])
    expect(items[1].assignees).toEqual([{ id: '1', login: 'me' }])
    expect(isAssignedToForgeAccount(items[1].assignees, {
      accountId: '1',
      accountLogin: 'me',
    })).toBe(true)
  })

  it('paginates ascending and does not skip older pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `p1-${i + 1}`,
      html_url: `https://github.com/acme/app/pull/${i + 1}`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      labels: [{ name: 'ai-review' }],
      head: { ref: `b${i}` },
      assignees: [{ id: 1, login: 'me' }],
    }))
    const page2 = [{
      number: 101,
      title: 'last',
      html_url: 'https://github.com/acme/app/pull/101',
      created_at: '2026-01-02T00:00:00Z',
      labels: [{ name: 'ai-review' }],
      head: { ref: 'last' },
      assignees: [{ id: 1, login: 'me' }],
    }]
    let call = 0
    mock.mockImplementation(async (url: string) => {
      const u = String(url)
      call += 1
      // Match &page=N (avoid false positive from per_page=100 containing "page=1")
      if (/[?&]page=1(?:&|$)/.test(u)) return jsonResponse(200, page1)
      if (/[?&]page=2(?:&|$)/.test(u)) return jsonResponse(200, page2)
      return jsonResponse(200, [])
    })

    const items = await listGitHubAiPullRequests('tok', 'acme/app')
    expect(items).toHaveLength(101)
    expect(items[0].externalId).toBe('1')
    expect(items[100].externalId).toBe('101')
    expect(call).toBeGreaterThanOrEqual(2)
  })
})

describe('listGitLabAiMergeRequests assignees', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses assignees from assignees and assignee fields', async () => {
    mock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (!u.includes('/merge_requests?') || !u.includes('labels=ai-review')) {
        return jsonResponse(200, [])
      }
      return jsonResponse(200, [
        {
          iid: 5,
          title: 'mine',
          web_url: 'https://gitlab.example/g/p/-/merge_requests/5',
          created_at: '2026-01-02T00:00:00Z',
          source_branch: 'feat',
          labels: ['ai-review'],
          assignees: [{ id: 42, username: 'samirahimi' }],
          assignee: { id: 42, username: 'samirahimi' },
        },
      ])
    })

    const items = await listGitLabAiMergeRequests('https://gitlab.example', 'tok', 'g/p')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      externalId: '5',
      assignees: [{ id: '42', login: 'samirahimi' }],
    })
    expect(isAssignedToForgeAccount(items[0].assignees, {
      accountId: '42',
      accountLogin: 'samirahimi',
    })).toBe(true)
  })

  it('parses assignees on unlabeled ai/issue-* safety-net MRs', async () => {
    mock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (!u.includes('/merge_requests?')) return jsonResponse(200, [])
      if (u.includes('labels=')) return jsonResponse(200, [])
      return jsonResponse(200, [
        {
          iid: 9,
          title: 'branch only',
          web_url: 'https://gitlab.example/g/p/-/merge_requests/9',
          created_at: '2026-01-03T00:00:00Z',
          source_branch: 'ai/issue-9',
          labels: [],
          assignees: [{ id: 7, username: 'other' }],
          assignee: null,
        },
      ])
    })

    const items = await listGitLabAiMergeRequests('https://gitlab.example', 'tok', 'g/p')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      externalId: '9',
      sourceBranch: 'ai/issue-9',
      assignees: [{ id: '7', login: 'other' }],
    })
  })
})
