import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectChat, postProjectChatMessage } from '../../server/services/project-chat'
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][], conditions: [] as unknown[], saved: {} as Record<string, unknown>,
  llm: vi.fn(), context: vi.fn(), workspace: vi.fn(),
}))
vi.mock('#utils/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: (condition: unknown) => {
    mocks.conditions.push(condition)
    return { limit: async () => mocks.rows.shift() || [] }
  } }) }),
  update: () => ({ set: (values: Record<string, unknown>) => {
    mocks.saved = values
    return { where: () => ({ returning: async () => [{ id: 'chat', ...values }] }) }
  } }),
}) }))
vi.mock('#services/task-planning', () => ({ ensurePlanningWorkspace: mocks.workspace }))
vi.mock('#services/task-planning-context', () => ({ buildRepoCodeContext: mocks.context }))
vi.mock('#services/task-planning-llm', () => ({
  callPlanningLlm: mocks.llm, planningProviderForRepo: async () => 'openai',
}))
const actor = { id: 'owner', username: 'owner' }
const repo = { id: 'repo', name: 'Demo', workspaceStatus: 'ready', localPath: '/tmp/repo', codegraphEnabled: true }
const session = { id: 'chat', repositoryId: 'repo', createdByUserId: 'owner', title: 'New chat', messages: [], updatedAt: new Date() }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows = []
  mocks.conditions = []
  mocks.saved = {}
  mocks.context.mockResolvedValue({ summary: 'src/example.ts', available: true })
  mocks.llm.mockResolvedValue({ text: 'See src/example.ts' })
})
describe('project conversations', () => {
  it('does not expose a conversation absent from the owner-scoped query', async () => {
    mocks.rows = [[]]
    await expect(getProjectChat('chat', 'another-user')).rejects.toThrow('Chat not found')
    expect(mocks.conditions[0]).toBeDefined()
    expect(mocks.llm).not.toHaveBeenCalled()
  })
  it('persists a question and answer with a title and refreshed repository context', async () => {
    mocks.rows = [[session], [repo], [repo], [repo]]
    await postProjectChatMessage('chat', 'Where is the entry point?', actor)
    expect(mocks.context).toHaveBeenCalledWith(expect.objectContaining({ prepareCodegraph: true, codegraphEnabled: true }))
    expect(mocks.saved.title).toBe('Where is the entry point?')
    expect(mocks.saved.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Where is the entry point?' }),
      expect.objectContaining({ role: 'assistant', content: 'See src/example.ts' }),
    ])
    expect(mocks.llm.mock.calls[0]![0].messages[0].content).toContain('src/example.ts')
    expect(mocks.llm.mock.calls[0]![0].messages[0].content).toContain('fenced code block tagged mermaid')
  })
  it('leaves saved history untouched when the provider fails', async () => {
    mocks.rows = [[session], [repo], [repo], [repo]]
    mocks.llm.mockRejectedValueOnce(new Error('Provider offline'))
    await expect(postProjectChatMessage('chat', 'Question', actor)).rejects.toThrow('Provider offline')
    expect(mocks.saved).toEqual({})
  })
})
