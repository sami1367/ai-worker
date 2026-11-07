import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openChatGitHubPullRequest } from '../../server/services/forge-github'
import { openChatGitLabMergeRequest } from '../../server/services/forge-gitlab'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('#utils/safe-fetch', () => ({ safeFetch: mocks.fetch, normalizeInstanceUrl: (url: string) => url.replace(/\/+$/, '') }))
const response = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body })
beforeEach(() => { vi.clearAllMocks() })
describe('chat work forge requests', () => {
  it('creates a GitHub pull request without issue creation or AI issue labels', async () => {
    mocks.fetch.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ html_url: 'https://github.com/org/api/pull/1' }))
    await openChatGitHubPullRequest({ token: 'token', fullName: 'org/api', branch: 'ai/chat-run', targetBranch: 'main', title: 'Implement', body: 'Approved local plan' })
    expect(mocks.fetch.mock.calls[1]![0]).toBe('https://api.github.com/repos/org/api/pulls')
    const body = JSON.parse(mocks.fetch.mock.calls[1]![1].body)
    expect(body).toEqual(expect.objectContaining({ head: 'ai/chat-run', base: 'main' }))
    expect(body.labels).toBeUndefined()
    expect(mocks.fetch.mock.calls.every(([url]) => !String(url).includes('/issues'))).toBe(true)
  })
  it('reuses an existing GitHub request after a publishing retry', async () => {
    mocks.fetch.mockResolvedValueOnce(response([{ html_url: 'https://github.com/org/api/pull/1' }]))
    expect(await openChatGitHubPullRequest({ token: 'token', fullName: 'org/api', branch: 'ai/chat-run', targetBranch: 'main', title: 'Implement', body: 'Plan' })).toContain('/pull/1')
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
  it('creates one GitLab MR for a service and reuses its branch on retry', async () => {
    mocks.fetch.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ web_url: 'https://gitlab.com/org/api/-/merge_requests/2' }))
    const opts = { token: 'token', instanceUrl: 'https://gitlab.com', project: 'org/api', branch: 'ai/chat-run', targetBranch: 'main', title: 'Implement', body: 'Plan' }
    await openChatGitLabMergeRequest(opts)
    expect(mocks.fetch.mock.calls[1]![0]).toBe('https://gitlab.com/api/v4/projects/org%2Fapi/merge_requests')
    mocks.fetch.mockResolvedValueOnce(response([{ web_url: 'https://gitlab.com/org/api/-/merge_requests/2' }]))
    expect(await openChatGitLabMergeRequest(opts)).toContain('/merge_requests/2')
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })
})
