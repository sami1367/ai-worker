import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, '') || 'https://gitlab.com',
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { listGitLabProjects, normalizeGitLabInstanceUrl } from '../../server/services/forge-gitlab'

describe('GitLab discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('normalizes default gitlab.com URL', () => {
    expect(normalizeGitLabInstanceUrl(undefined)).toBe('https://gitlab.com')
  })

  it('paginates using x-next-page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      path_with_namespace: `group/proj-${i}`,
      path: `proj-${i}`,
      name: `proj-${i}`,
      namespace: { full_path: 'group', path: 'group' },
      visibility: 'private',
      default_branch: 'main',
      http_url_to_repo: `https://gitlab.com/group/proj-${i}.git`,
      web_url: `https://gitlab.com/group/proj-${i}`,
      archived: false,
      permissions: { project_access: { access_level: 40 } },
    }))
    const page2 = [{
      id: 999,
      path_with_namespace: 'group/final',
      path: 'final',
      name: 'final',
      namespace: { full_path: 'group' },
      visibility: 'internal',
      default_branch: 'develop',
      http_url_to_repo: 'https://gitlab.com/group/final.git',
      web_url: 'https://gitlab.com/group/final',
      archived: false,
      permissions: { group_access: { access_level: 30 } },
    }]

    const mock = safeFetch as unknown as ReturnType<typeof vi.fn>
    let call = 0
    mock.mockImplementation(async () => {
      call += 1
      const body = call === 1 ? page1 : page2
      const headers = new Headers()
      if (call === 1) headers.set('x-next-page', '2')
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    })

    const repos = await listGitLabProjects('https://gitlab.com', 'fake-token')
    expect(repos.length).toBe(101)
    expect(repos[100].fullName).toBe('group/final')
    expect(repos[100].visibility).toBe('internal')
  })
})
