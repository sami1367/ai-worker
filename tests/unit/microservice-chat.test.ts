import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { microserviceChatSessions } from '../../database/schema'
import { createMicroserviceChat, getMicroserviceChat, microserviceChatContext, postMicroserviceChatMessage } from '../../server/services/microservice-chat'
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][], conditions: [] as unknown[], saved: {} as Record<string, unknown>,
  llm: vi.fn(), context: vi.fn(), owned: vi.fn(), projects: vi.fn(), prefer: vi.fn(),
}))
vi.mock('#utils/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: (condition: unknown) => {
    mocks.conditions.push(condition)
    return { limit: async () => mocks.rows.shift() || [] }
  } }) }),
  insert: () => ({ values: (values: Record<string, unknown>) => {
    mocks.saved = values
    return { returning: async () => [{ id: 'chat', ...values }] }
  } }),
  update: () => ({ set: (values: Record<string, unknown>) => {
    mocks.saved = values
    return { where: () => ({ returning: async () => [{ id: 'chat', ...values }] }) }
  } }),
}) }))
vi.mock('#services/microservice-groups', () => ({ ownedMicroserviceGroup: mocks.owned, microserviceRepositories: mocks.projects }))
vi.mock('#services/task-planning-context', () => ({ buildRepoCodeContext: mocks.context }))
vi.mock('#services/task-planning-llm', () => ({ callPlanningLlm: mocks.llm, planningProviderForRepo: mocks.prefer }))
vi.mock('#services/microservice-workspace', () => ({ microserviceWorkspacePath: () => '/tmp/test-group' }))
const group = { id: 'group', name: 'Avat', description: 'Platform', workspaceStatus: 'ready', codegraphStatus: 'ready', preparedAt: new Date(), updatedAt: new Date() }
const session = { id: 'chat', groupId: 'group', createdByUserId: 'owner', title: 'New chat', messages: [], updatedAt: new Date() }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows = []
  mocks.conditions = []
  mocks.saved = {}
  mocks.owned.mockResolvedValue(group)
  mocks.projects.mockResolvedValue([
    { directory: 'api', labels: ['backend'], description: 'Public HTTP endpoints', repository: { name: 'API', defaultAiProvider: 'claude' } },
    { directory: 'gateway', labels: ['gateway'], description: 'Routes requests', repository: { name: 'Gateway', defaultAiProvider: 'codex' } },
  ])
  mocks.context.mockImplementation(async ({ localPath }: { localPath: string }) => ({ available: true, summary: `${localPath}/entry.ts` }))
  mocks.prefer.mockResolvedValue('claude')
  mocks.llm.mockResolvedValue({ text: 'The gateway calls the API.' })
})
describe('microservice chat', () => {
  it('scopes session lookup to both the selected group and the user', async () => {
    mocks.rows = [[]]
    await expect(getMicroserviceChat('group', 'chat', 'owner')).rejects.toThrow('Chat not found')
    expect(mocks.owned).toHaveBeenCalledWith('group', 'owner')
    const query = new PgDialect().sqlToQuery(mocks.conditions[0] as Parameters<PgDialect['sqlToQuery']>[0])
    expect(query.params).toEqual(['chat', 'group', 'owner'])
    expect(query.sql).toContain(microserviceChatSessions.groupId.name)
  })
  it('does not create or disclose chats when the group belongs to someone else', async () => {
    mocks.owned.mockRejectedValue(new Error('Microservice group not found'))
    await expect(createMicroserviceChat('group', 'stranger')).rejects.toThrow('not found')
    expect(mocks.saved).toEqual({})
  })
  it('includes every selected service, its directory and labels in context', async () => {
    const { context } = await microserviceChatContext('group', 'owner', 'How are requests routed?')
    for (const text of ['API', 'Gateway', 'api/', 'gateway/', 'backend', 'Public HTTP endpoints', '/tmp/test-group/gateway/entry.ts']) expect(context).toContain(text)
    expect(mocks.context).toHaveBeenCalledWith(expect.objectContaining({ localPath: '/tmp/test-group', codegraphEnabled: true }))
  })
  it('blocks questions until the group workspace is ready', async () => {
    mocks.owned.mockResolvedValue({ ...group, workspaceStatus: 'waiting' })
    await expect(microserviceChatContext('group', 'owner', 'Question')).rejects.toThrow('Wait for')
    expect(mocks.context).not.toHaveBeenCalled()
  })
  it('keeps snapshot-based chat available when CodeGraph is unavailable', async () => {
    mocks.owned.mockResolvedValue({ ...group, codegraphStatus: 'unavailable' })
    await microserviceChatContext('group', 'owner', 'Question')
    expect(mocks.context).toHaveBeenCalledWith(expect.objectContaining({ localPath: '/tmp/test-group', codegraphEnabled: false }))
  })
  it('saves a conversation about all services and instructs the AI to distinguish them', async () => {
    mocks.rows = [[session]]
    await postMicroserviceChatMessage('group', 'chat', 'How do these services connect?', 'owner')
    expect(mocks.saved.title).toBe('How do these services connect?')
    expect(mocks.saved.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'How do these services connect?' }),
      expect.objectContaining({ role: 'assistant', content: 'The gateway calls the API.' }),
    ])
    const system = mocks.llm.mock.calls[0]![0].messages[0].content
    expect(system).toContain('cite paths with their service directory prefix')
    expect(system).toContain('fenced code block tagged mermaid')
    expect(system).toContain('API')
    expect(system).toContain('Gateway')
    expect(mocks.prefer).toHaveBeenCalledWith('claude')
  })
  it('keeps saved history unchanged when the provider fails', async () => {
    mocks.rows = [[session]]
    mocks.llm.mockRejectedValueOnce(new Error('Provider offline'))
    await expect(postMicroserviceChatMessage('group', 'chat', 'Question', 'owner')).rejects.toThrow('Provider offline')
    expect(mocks.saved).toEqual({})
  })
  it('rejects a stale reply if group settings changed during generation', async () => {
    mocks.rows = [[session]]
    mocks.owned.mockResolvedValueOnce(group).mockResolvedValueOnce(group).mockResolvedValueOnce({ ...group, updatedAt: new Date(group.updatedAt.getTime() + 1000) })
    await expect(postMicroserviceChatMessage('group', 'chat', 'Question', 'owner')).rejects.toThrow('group changed')
    expect(mocks.saved).toEqual({})
  })
})
