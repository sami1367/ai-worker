import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeChatWork } from '../../server/services/chat-work-execution'
const mocks = vi.hoisted(() => ({
  run: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[], commit: vi.fn(), push: vi.fn(), github: vi.fn(), gitlab: vi.fn(), changes: vi.fn(), git: vi.fn(),
}))
vi.mock('#utils/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [mocks.run] }) }) }),
  update: () => ({ set: (values: Record<string, unknown>) => {
    mocks.updates.push(values)
    return { where: () => Object.assign(Promise.resolve(), { returning: async () => [{ ...mocks.run, ...values }] }) }
  } }),
}) }))
vi.mock('#services/chat-work-git', () => ({
  restoreChatWorkGitConfig: async () => {}, chatWorkDirectory: () => '/work', chatWorkBranch: (id: string) => `ai/chat-${id}`,
  chatWorkChanges: mocks.changes, chatWorkGit: mocks.git, commitChatWork: mocks.commit, pushChatWorkBranch: mocks.push,
}))
vi.mock('#services/connections', () => ({ getConnectionAccessToken: async (id: string) => ({ token: 'secret', row: { provider: id === 'github' ? 'github' : 'gitlab', instanceUrl: 'https://gitlab.com' } }) }))
vi.mock('#services/forge-github', () => ({ openChatGitHubPullRequest: mocks.github }))
vi.mock('#services/forge-gitlab', () => ({ openChatGitLabMergeRequest: mocks.gitlab }))
const repos = [
  { id: 'api', name: 'API', directory: 'api', forgeType: 'github', connectionId: 'github', baseCommit: 'baseline', targetBranch: 'main', fullName: 'org/api' },
  { id: 'gateway', name: 'Gateway', directory: 'gateway', forgeType: 'gitlab', connectionId: 'gitlab', baseCommit: 'baseline', targetBranch: 'main', fullName: 'org/gateway' },
]
beforeEach(() => {
  vi.clearAllMocks(); mocks.updates = []
  mocks.run = { id: 'run', leaseToken: 'lease', status: 'running', agentCompletedAt: null, results: [], title: 'Update contracts', chatUrl: '/microservices/group?chat=session',
    tasks: [{ title: 'Coordinate contracts', body: 'Update endpoints and tests', repositoryIds: ['api', 'gateway'] }], repositorySnapshot: repos }
  mocks.commit.mockResolvedValue({ commit: 'new-commit', tree: 'new-tree' })
  mocks.changes.mockResolvedValue(''); mocks.git.mockResolvedValue('baseline')
  mocks.github.mockResolvedValue('https://github.com/org/api/pull/1')
  mocks.gitlab.mockResolvedValue('https://gitlab.com/org/gateway/-/merge_requests/2')
})
async function finished() {
  await vi.waitFor(() => expect(mocks.updates.some(update => ['succeeded', 'partial', 'failed', 'no_changes'].includes(String(update.status)))).toBe(true))
  return mocks.updates.at(-1)!
}
describe('background chat work publishing', () => {
  it('never publishes when the coding agent exits unsuccessfully', async () => {
    expect(await completeChatWork('run', 'lease', 9)).toEqual({ status: 'failed' })
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.github).not.toHaveBeenCalled(); expect(mocks.gitlab).not.toHaveBeenCalled()
  })
  it('opens one request per changed repository with a link to the conversation', async () => {
    await completeChatWork('run', 'lease', 0)
    expect((await finished()).status).toBe('succeeded')
    expect(mocks.github).toHaveBeenCalledOnce(); expect(mocks.gitlab).toHaveBeenCalledOnce(); expect(mocks.push).toHaveBeenCalledTimes(2)
    expect(mocks.github.mock.calls[0]![0].body).toContain('/microservices/group?chat=session')
    expect(mocks.github.mock.calls[0]![0].branch).toBe('ai/chat-run')
  })
  it('reports unchanged services without publishing empty requests', async () => {
    mocks.commit.mockResolvedValue(null)
    await completeChatWork('run', 'lease', 0)
    expect((await finished()).status).toBe('no_changes')
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.github).not.toHaveBeenCalled()
  })
  it('retains successful requests and reports partial failures for retry', async () => {
    mocks.gitlab.mockRejectedValueOnce(new Error('GitLab unavailable'))
    await completeChatWork('run', 'lease', 0)
    expect((await finished()).status).toBe('partial')
    const writes = mocks.updates.filter(update => update.results)
    expect(writes.at(-1)!.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryId: 'api', status: 'created', url: 'https://github.com/org/api/pull/1' }),
      expect.objectContaining({ repositoryId: 'gateway', status: 'failed', commit: 'new-commit' }),
    ]))
  })
  it('retries only unfinished repositories and reuses the previous committed tree', async () => {
    mocks.run.results = [{ repositoryId: 'api', status: 'created', url: 'https://github.com/org/api/pull/1' }, { repositoryId: 'gateway', status: 'failed', tree: 'saved-tree' }]
    mocks.run.agentCompletedAt = new Date()
    await completeChatWork('run', 'lease', 0)
    await finished()
    expect(mocks.github).not.toHaveBeenCalled(); expect(mocks.gitlab).toHaveBeenCalledOnce()
    expect(mocks.commit).toHaveBeenCalledWith('/work/gateway', expect.objectContaining({ id: 'gateway' }), 'run', 'Update contracts', 'saved-tree', expect.any(Function))
  })
  it('stops before publishing if a context-only repository changed', async () => {
    mocks.run.tasks = [{ title: 'API only', body: 'Fix API', repositoryIds: ['api'] }]
    mocks.changes.mockResolvedValue(' M router.ts')
    await completeChatWork('run', 'lease', 0)
    expect((await finished()).status).toBe('failed')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.github).not.toHaveBeenCalled()
  })
  it('does not restart publication on duplicate completion callbacks', async () => {
    mocks.run.status = 'publishing'
    await completeChatWork('run', 'lease', 0)
    expect(mocks.commit).not.toHaveBeenCalled()
  })
})
