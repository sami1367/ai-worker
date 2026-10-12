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

  it('creates all AI labels when none exist', async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: 1 }))
    await ensureGitHubRepoLabels('tok', 'acme/app', AI_WORKER_LABELS)
    expect(mockFetch).toHaveBeenCalledTimes(AI_WORKER_LABELS.length)
    const firstUrl = String(mockFetch.mock.calls[0][0])
    expect(firstUrl).toContain('/repos/acme/app/labels')
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.name).toBe('ai')
    expect(body.color).toBe('0E8A16')
  })

  it('updates when create returns 422 (already exists)', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonResponse(422, { message: 'already exists' })
      return jsonResponse(200, { id: 1 })
    })
    await ensureGitHubRepoLabels('tok', 'acme/app', [{
      name: 'ai',
      color: '0E8A16',
      description: 'Queue',
    }])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[1][1].method).toBe('PATCH')
  })
})

describe('ensureGitLabProjectLabels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates labels then updates on 409 conflict', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonResponse(409, { message: 'conflict' })
      return jsonResponse(200, { id: 1 })
    })
    await ensureGitLabProjectLabels('https://gitlab.com', 'tok', 'group/proj', [{
      name: 'ai-review',
      color: '7057FF',
      description: 'Review',
    }])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(String(mockFetch.mock.calls[0][0])).toContain('/projects/group%2Fproj/labels')
    expect(mockFetch.mock.calls[1][1].method).toBe('PUT')
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.color).toBe('#7057FF')
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
