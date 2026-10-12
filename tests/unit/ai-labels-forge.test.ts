import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, ''),
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { ensureGitHubRepoLabels } from '../../server/services/forge-github'
import { ensureGitLabProjectLabels } from '../../server/services/forge-gitlab'
import { AI_WORKER_LABELS } from '../../server/services/ai-labels-def'

const mockFetch = safeFetch as unknown as ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('ensureGitHubRepoLabels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists existing labels then creates only missing ones', async () => {
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url)
      if (!init?.method || init.method === 'GET') {
        return jsonResponse(200, [{ name: 'ai' }, { name: 'bug' }])
      }
      if (init.method === 'POST') return jsonResponse(201, { id: 1 })
      return jsonResponse(500, { message: 'unexpected' })
    })

    const result = await ensureGitHubRepoLabels('tok', 'acme/app', AI_WORKER_LABELS)
    expect(result.existing).toBe(1) // ai already present
    expect(result.created).toBe(AI_WORKER_LABELS.length - 1)
    const posts = mockFetch.mock.calls.filter((c) => c[1]?.method === 'POST')
    expect(posts.length).toBe(AI_WORKER_LABELS.length - 1)
    expect(posts.some((c) => JSON.parse(String(c[1].body)).name === 'ai')).toBe(false)
    expect(posts.some((c) => JSON.parse(String(c[1].body)).name === 'ai-review')).toBe(true)
  })

  it('creates all AI labels when none exist', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (!init?.method || init.method === 'GET') return jsonResponse(200, [])
      return jsonResponse(201, { id: 1 })
    })
    const result = await ensureGitHubRepoLabels('tok', 'acme/app', AI_WORKER_LABELS)
    expect(result.created).toBe(AI_WORKER_LABELS.length)
    expect(result.existing).toBe(0)
  })
})

describe('ensureGitLabProjectLabels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips labels that already exist', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (!init?.method || init.method === 'GET') {
        return jsonResponse(200, [{ name: 'ai-review' }])
      }
      return jsonResponse(201, { id: 1 })
    })
    const result = await ensureGitLabProjectLabels('https://gitlab.com', 'tok', 'group/proj', [
      { name: 'ai-review', color: '7057FF', description: 'Review' },
      { name: 'ai', color: '0E8A16', description: 'Queue' },
    ])
    expect(result.existing).toBe(1)
    expect(result.created).toBe(1)
    expect(String(mockFetch.mock.calls[0][0])).toContain('/projects/group%2Fproj/labels')
  })
})

describe('AI_WORKER_LABELS', () => {
  it('includes implement and review label sets', () => {
    const names = AI_WORKER_LABELS.map((l) => l.name)
    expect(names).toEqual([
      'ai',
      'ai-working',
      'ai-pr',
      'ai-failed',
      'ai-review',
      'ai-reviewing',
      'ai-reviewed',
      'ai-review-failed',
    ])
  })
})
