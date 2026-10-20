import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  assertSafeOutboundUrl: async (u: string) => new URL(u),
  normalizeInstanceUrl: (u: string) => u.replace(/\/+$/, ''),
  trustedHostsFromEnv: () => [],
}))

import { safeFetch } from '../../server/utils/safe-fetch'
import { createGitHubIssue } from '../../server/services/forge-github'
import { createGitLabIssue } from '../../server/services/forge-gitlab'

const mock = safeFetch as unknown as ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => text,
  }
}

describe('forge create issue', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a GitHub issue with ai label and assignee', async () => {
    mock.mockResolvedValueOnce(jsonResponse(201, {
      number: 42,
      title: 'Add login',
      html_url: 'https://github.com/acme/app/issues/42',
    }))

    const issue = await createGitHubIssue({
      token: 'ghp_test',
      fullName: 'acme/app',
      title: 'Add login',
      body: 'Goal',
      labels: ['ai'],
      assignees: ['octocat'],
    })

    expect(issue.externalId).toBe('42')
    expect(issue.url).toContain('/issues/42')
    expect(mock).toHaveBeenCalledOnce()
    const [url, init] = mock.mock.calls[0]!
    expect(String(url)).toContain('/repos/acme/app/issues')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.labels).toEqual(['ai'])
    expect(body.assignees).toEqual(['octocat'])
  })

  it('creates a GitLab issue with ai label and assignee id', async () => {
    mock.mockResolvedValueOnce(jsonResponse(201, {
      iid: 7,
      title: 'Add login',
      web_url: 'https://gitlab.com/acme/app/-/issues/7',
    }))

    const issue = await createGitLabIssue({
      instanceUrl: 'https://gitlab.com',
      token: 'glpat-test',
      projectPath: 'acme/app',
      title: 'Add login',
      body: 'Goal',
      labels: ['ai'],
      assigneeIds: [99],
    })

    expect(issue.externalId).toBe('7')
    expect(issue.url).toContain('/issues/7')
    const [, init] = mock.mock.calls[0]!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.labels).toBe('ai')
    expect(body.assignee_ids).toEqual([99])
    expect(body.description).toBe('Goal')
  })
})
