import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, '') || 'https://gitlab.com',
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { listGitHubBranches } from '../../server/services/forge-github'
import { listGitLabBranches } from '../../server/services/forge-gitlab'
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

describe('listGitHubBranches', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('paginates until a short page and returns branch names', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `branch-${i}` }))
    const page2 = [{ name: 'main' }, { name: 'develop' }]

    mock.mockImplementation(async (url: string) => {
      const page = Number(new URL(String(url)).searchParams.get('page') || '1')
      expect(String(url)).toContain('/repos/acme/app/branches')
      return jsonResponse(200, page === 1 ? page1 : page2)
    })

    const branches = await listGitHubBranches('tok', 'acme/app')
    expect(branches).toHaveLength(102)
    expect(branches[0]).toBe('branch-0')
    expect(branches[100]).toBe('main')
    expect(branches[101]).toBe('develop')
  })

  it('skips entries without a name', async () => {
    mock.mockResolvedValue(jsonResponse(200, [{ name: 'main' }, {}, { name: 'feat' }]))
    const branches = await listGitHubBranches('tok', 'https://github.com/acme/app.git')
    expect(branches).toEqual(['main', 'feat'])
  })

  it('returns an empty list when the first page is empty', async () => {
    mock.mockResolvedValue(jsonResponse(200, []))
    await expect(listGitHubBranches('tok', 'acme/app')).resolves.toEqual([])
  })

  it('throws on unauthorized', async () => {
    mock.mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }))
    await expect(listGitHubBranches('bad', 'acme/app')).rejects.toMatchObject({
      code: 'forge_unauthorized',
    } satisfies Partial<AppError>)
  })
})

describe('listGitLabBranches', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('paginates and returns branch names', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `gl-${i}` }))
    const page2 = [{ name: 'main' }]

    let call = 0
    mock.mockImplementation(async (url: string) => {
      call += 1
      expect(String(url)).toContain('/projects/group%2Fproj/repository/branches')
      return jsonResponse(200, call === 1 ? page1 : page2)
    })

    const branches = await listGitLabBranches('https://gitlab.com', 'tok', 'group/proj')
    expect(branches).toHaveLength(101)
    expect(branches[100]).toBe('main')
  })

  it('accepts numeric project ids', async () => {
    mock.mockResolvedValue(jsonResponse(200, [{ name: 'master' }]))
    const branches = await listGitLabBranches('https://gitlab.com/', 'tok', '42')
    expect(branches).toEqual(['master'])
    expect(String(mock.mock.calls[0][0])).toContain('/projects/42/repository/branches')
  })

  it('returns an empty list when the first page is empty', async () => {
    mock.mockResolvedValue(jsonResponse(200, []))
    await expect(listGitLabBranches('https://gitlab.com', 'tok', 'group/proj')).resolves.toEqual([])
  })

  it('skips entries without a name', async () => {
    mock.mockResolvedValue(jsonResponse(200, [{ name: 'main' }, {}, { name: 'feat' }]))
    await expect(listGitLabBranches('https://gitlab.com', 'tok', '/group/proj.git')).resolves.toEqual([
      'main',
      'feat',
    ])
  })

  it('throws on forbidden', async () => {
    mock.mockResolvedValue(jsonResponse(403, { message: 'Forbidden' }))
    await expect(listGitLabBranches('https://gitlab.com', 'tok', 'group/proj')).rejects.toMatchObject({
      code: 'forge_forbidden',
    } satisfies Partial<AppError>)
  })
})
