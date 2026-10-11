import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, ''),
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { listGitHubRepositories } from '../../server/services/forge-github'

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

    const mock = safeFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockImplementation(async (url: string) => {
      const page = Number(new URL(String(url)).searchParams.get('page') || '1')
      const body = page === 1 ? page1 : page2
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    })

    const repos = await listGitHubRepositories('fake-token')
    expect(repos.length).toBe(101)
    expect(repos[100].fullName).toBe('org/last')
    expect(repos[100].permissions).toMatchObject({ admin: true, push: true })
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
