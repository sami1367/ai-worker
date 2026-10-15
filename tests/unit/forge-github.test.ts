import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, ''),
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import {
  listGitHubAiPullRequests,
  listGitHubRepositories,
} from '../../server/services/forge-github'
import { AppError } from '../../server/utils/errors'

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

describe('listGitHubRepositories pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('follows pages until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      full_name: `org/repo-${i}`,
      owner: { login: 'org' },
      name: `repo-${i}`,
      private: true,
      default_branch: 'main',
      clone_url: `https://github.com/org/repo-${i}.git`,
      html_url: `https://github.com/org/repo-${i}`,
      permissions: { admin: false, push: true, pull: true },
      archived: false,
      fork: false,
    }))
    const page2 = [{
      id: 101,
      full_name: 'org/last',
      owner: { login: 'org' },
      name: 'last',
      private: false,
      default_branch: 'main',
      clone_url: 'https://github.com/org/last.git',
      html_url: 'https://github.com/org/last',
      permissions: { admin: true, push: true, pull: true },
      archived: false,
      fork: false,
    }]

    mock.mockImplementation(async (url: string) => {
      const page = Number(new URL(String(url)).searchParams.get('page') || '1')
      return jsonResponse(200, page === 1 ? page1 : page2)
    })

    const repos = await listGitHubRepositories('fake-token')
    expect(repos.length).toBe(101)
    expect(repos[100].fullName).toBe('org/last')
    expect(repos[100].permissions).toMatchObject({ admin: true, push: true })
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('listGitHubAiPullRequests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('filters open pulls by AI labels via pulls API (not search)', async () => {
    mock.mockImplementation(async (url: string) => {
      expect(String(url)).toContain('/repos/acme/app/pulls')
      expect(String(url)).not.toContain('/search/')
      return jsonResponse(200, [
        {
          number: 1,
          title: 'AI work',
          html_url: 'https://github.com/acme/app/pull/1',
          created_at: '2024-01-02T00:00:00Z',
          labels: [{ name: 'ai-review' }],
          head: { ref: 'feat/ai' },
        },
        {
          number: 2,
          title: 'Human PR',
          html_url: 'https://github.com/acme/app/pull/2',
          created_at: '2024-01-01T00:00:00Z',
          labels: [{ name: 'bug' }],
          head: { ref: 'fix' },
        },
        {
          number: 3,
          title: 'Unlabeled AI branch',
          html_url: 'https://github.com/acme/app/pull/3',
          created_at: '2024-01-03T00:00:00Z',
          labels: [],
          head: { ref: 'ai/issue-9' },
        },
      ])
    })

    const items = await listGitHubAiPullRequests('tok', 'acme/app')
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      externalId: '1',
      kind: 'pull_request',
      sourceBranch: 'feat/ai',
      labels: ['ai-review'],
    })
    expect(items[1]).toMatchObject({
      externalId: '3',
      sourceBranch: 'ai/issue-9',
      labels: [],
    })
  })

  it('maps rate-limit 403 to forge_rate_limited', async () => {
    mock.mockResolvedValue(jsonResponse(
      403,
      { message: 'API rate limit exceeded' },
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
    ))

    await expect(listGitHubAiPullRequests('tok', 'acme/app')).rejects.toMatchObject({
      statusCode: 429,
      code: 'forge_rate_limited',
    } satisfies Partial<AppError>)
  })
})
