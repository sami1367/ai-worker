import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { approveChatWork, generateChatWork, getChatWork, loadChatWorkSource, parseChatWorkTasks, publicChatWorkRun } from '../../server/services/chat-work'
import type { chatWorkRuns } from '../../database/schema'
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], conditions: [] as unknown[], updates: [] as Record<string, unknown>[], inserted: [] as Record<string, unknown>[],
  state: {} as Record<string, unknown>, run: {} as Record<string, unknown>, llm: vi.fn(), git: vi.fn(), token: vi.fn(), audit: vi.fn() }))
vi.mock('#utils/db', () => ({ getDb: () => db }))
const db = {
  select: () => ({ from: () => {
    const query = {
      where: (condition: unknown) => { mocks.conditions.push(condition); return query },
      for: () => query, orderBy: () => query,
      limit: async () => mocks.rows.shift() || [],
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(mocks.rows.shift() || []).then(resolve),
    }
    return query
  } }),
  insert: () => ({ values: (values: Record<string, unknown>) => {
    mocks.inserted.push(values)
    return { onConflictDoNothing: async () => {}, returning: async () => [{ ...mocks.run, ...values }] }
  } }),
  update: () => ({ set: (values: Record<string, unknown>) => {
    mocks.updates.push(values)
    return { where: () => Object.assign(Promise.resolve(), { returning: async () => [{ ...mocks.state, ...values }] }) }
  } }),
  transaction: async (callback: (tx: unknown) => unknown) => callback(db),
}
vi.mock('#services/chat-work-git', () => ({ chatWorkGit: mocks.git }))
vi.mock('#services/connections', () => ({ getConnectionAccessToken: mocks.token }))
vi.mock('#services/audit', () => ({ writeAudit: mocks.audit }))
vi.mock('#services/task-planning-llm', () => ({ callPlanningLlm: mocks.llm, planningProviderForRepo: async () => 'codex' }))
vi.mock('#services/task-planning-context', () => ({ buildRepoCodeContext: async () => ({ summary: 'src/api.ts', available: true }) }))
const id = '11111111-1111-4111-8111-111111111111'
const repositoryId = '22222222-2222-4222-8222-222222222222'
const otherRepo = '33333333-3333-4333-8333-333333333333'
const actor = { id: 'owner', username: 'owner' }
const session = { id, repositoryId, createdByUserId: 'owner', title: 'Add billing', messages: [{ role: 'user', content: 'Add billing' }] }
const repo = { id: repositoryId, name: 'API', localPath: '/source', workspaceStatus: 'ready', isArchived: false, defaultBranch: 'main', defaultAiProvider: 'codex', codegraphEnabled: true, remoteUrl: 'https://github.com/org/api.git', canonicalProjectIdentifier: 'org/api', forgeType: 'github', connectionId: 'connection' }
const task = { id, title: 'Add billing endpoint', body: 'Implement billing and test it', repositoryIds: [repositoryId] }
let state: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows = []; mocks.updates = []; mocks.conditions = []; mocks.inserted = []
  state = { id: 'state', mode: 'work', revision: 1, tasks: [task], repositorySnapshot: [{ id: repositoryId, connectionId: 'connection' }], sourceFingerprint: '', generatedAt: null }
  mocks.state = state
  mocks.run = { id: 'run', status: 'queued', results: [], repositorySnapshot: [], createdAt: new Date() }
  mocks.git.mockResolvedValue('a'.repeat(40))
  mocks.llm.mockResolvedValue({ text: JSON.stringify({ tasks: [{ title: task.title, body: task.body, repositoryIds: [repositoryId] }] }) })
  mocks.token.mockResolvedValue({ token: 'secret', row: { provider: 'github' } })
})
async function currentSource() { mocks.rows.push([session], [repo]); return loadChatWorkSource('project', id, 'owner') }
describe('local chat work plans', () => {
  it('rejects foreign chats with an owner-scoped lookup', async () => {
    mocks.rows = [[]]
    await expect(loadChatWorkSource('project', id, 'stranger')).rejects.toThrow('Chat not found')
    const query = new PgDialect().sqlToQuery(mocks.conditions[0] as Parameters<PgDialect['sqlToQuery']>[0])
    expect(query.params).toEqual([id, 'stranger'])
  })
  it('defaults to chat mode without any implementation run', async () => {
    mocks.rows = [[session], [repo], [{ ...state, mode: 'chat', revision: 0, tasks: [], repositorySnapshot: [] }], []]
    const result = await getChatWork('project', id, 'owner')
    expect(result.mode).toBe('chat'); expect(result.tasks).toEqual([]); expect(result.runs).toEqual([])
    expect(mocks.llm).not.toHaveBeenCalled()
  })
  it('only accepts task repository IDs belonging to the chat', () => {
    expect(() => parseChatWorkTasks(JSON.stringify({ tasks: [{ ...task, repositoryIds: [otherRepo] }] }), [repositoryId])).toThrow('Check that you selected the correct repositories')
    expect(() => parseChatWorkTasks(JSON.stringify({ tasks: [{ ...task, title: '' }] }), [repositoryId])).toThrow('missing or invalid task fields')
    expect(() => parseChatWorkTasks('{bad json}', [repositoryId])).toThrow('invalid task JSON')
    expect(parseChatWorkTasks(JSON.stringify({ tasks: [task] }), [repositoryId])[0]!.repositoryIds).toEqual([repositoryId])
  })
  it('requires Work mode before generating a plan', async () => {
    mocks.rows = [[session], [repo], [{ ...state, mode: 'chat' }]]
    await expect(generateChatWork('project', id, 'owner')).rejects.toThrow('Switch to Work mode')
    expect(mocks.llm).not.toHaveBeenCalled()
  })
  it('regenerates by replacing the existing draft and increasing its revision', async () => {
    const fingerprint = (await currentSource()).fingerprint
    mocks.rows = [[session], [repo], [state], [], [session], [repo], [session], [repo], [{ ...state, revision: 2, sourceFingerprint: fingerprint }], []]
    await generateChatWork('project', id, 'owner')
    expect(mocks.updates[0]).toEqual(expect.objectContaining({ revision: 2, tasks: [expect.objectContaining({ title: task.title })] }))
    expect((mocks.updates[0]!.tasks as unknown[])).toHaveLength(1)
    expect(mocks.inserted.some(values => 'planRevision' in values)).toBe(false)
  })
  it('rejects approval after the conversation changes', async () => {
    mocks.rows = [[session], [repo], [state]]
    await expect(approveChatWork('project', id, actor, 1)).rejects.toThrow('fresh plan')
    expect(mocks.inserted.some(values => 'planRevision' in values)).toBe(false)
  })
  it('queues an approved local plan once without creating forge issues', async () => {
    state.sourceFingerprint = (await currentSource()).fingerprint
    mocks.rows = [[session], [repo], [state], [{ providerType: 'codex', isDefault: true }], [state], [], []]
    const result = await approveChatWork('project', id, actor, 1)
    expect(result.run.status).toBe('queued')
    expect(mocks.inserted.find(values => 'planRevision' in values)).toEqual(expect.objectContaining({ tasks: [task], planRevision: 1, chatUrl: `/project-chat/${repositoryId}?chat=${id}` }))
    expect(mocks.audit).toHaveBeenCalled()
  })
  it('returns the existing run for repeated approval of the same plan', async () => {
    state.sourceFingerprint = (await currentSource()).fingerprint
    mocks.rows = [[session], [repo], [state], [{ providerType: 'codex', isDefault: true }], [state], [mocks.run]]
    await approveChatWork('project', id, actor, 1)
    expect(mocks.inserted.some(values => 'planRevision' in values)).toBe(false)
  })
  it('never returns private execution paths or lease tokens to chat clients', () => {
    const result = publicChatWorkRun({ ...mocks.run, tasks: [task], leaseToken: 'private', repositorySnapshot: [{ id: repositoryId, name: 'API', directory: 'api', sourcePath: '/secret/path' }] } as unknown as typeof chatWorkRuns.$inferSelect)
    expect(JSON.stringify(result)).not.toContain('/secret/path')
    expect(JSON.stringify(result)).not.toContain('private')
  })
})
