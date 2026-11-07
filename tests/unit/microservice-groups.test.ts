import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { ownedMicroserviceGroup, processMicroserviceWorkspaces, saveMicroserviceGroup } from '../../server/services/microservice-groups'
const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][], updates: [] as Array<Record<string, unknown>>, conditions: [] as unknown[],
  claimed: {} as Record<string, unknown>, ensure: vi.fn(), queue: vi.fn(), clone: vi.fn(), manifest: vi.fn(), index: vi.fn(),
}))
vi.mock('#utils/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: (condition: unknown) => {
    mocks.conditions.push(condition)
    const rows = mocks.selectRows.shift() || []
    const result = Object.assign(Promise.resolve(rows), { limit: async () => rows, orderBy: () => ({ limit: async () => rows }) })
    return result
  } }) }),
  update: () => ({ set: (values: Record<string, unknown>) => {
    mocks.updates.push(values)
    return { where: () => Object.assign(Promise.resolve(), { returning: async () => [mocks.claimed] }) }
  } }),
}) }))
vi.mock('node:fs/promises', () => ({ access: async () => undefined }))
vi.mock('#services/task-planning', () => ({ ensurePlanningWorkspace: mocks.ensure }))
vi.mock('#services/workspace-manager', () => ({ queueWorkspaceOperation: mocks.queue }))
vi.mock('#services/microservice-workspace', () => ({
  microserviceWorkspacePath: () => '/tmp/group', projectDirectories: () => ['api', 'gateway'],
  syncMicroserviceClone: mocks.clone, writeMicroserviceManifest: mocks.manifest, indexMicroserviceWorkspace: mocks.index,
}))
const idA = '11111111-1111-4111-8111-111111111111'
const idB = '22222222-2222-4222-8222-222222222222'
const group = { id: 'group', createdByUserId: 'owner', name: 'Avat', description: 'Platform', codegraphEnabled: true, workspaceStatus: 'queued', updatedAt: new Date(), projects: [
  { repositoryId: idA, directory: 'api', labels: ['backend'], description: '' },
  { repositoryId: idB, directory: 'gateway', labels: ['gateway'], description: '' },
] }
const repos = [
  { id: idA, name: 'API', localPath: '/tmp/api', defaultBranch: 'main', workspaceStatus: 'ready', isArchived: false },
  { id: idB, name: 'Gateway', localPath: '/tmp/gateway', defaultBranch: 'main', workspaceStatus: 'ready', isArchived: false },
]
beforeEach(() => {
  vi.clearAllMocks()
  mocks.selectRows = []
  mocks.updates = []
  mocks.conditions = []
  mocks.claimed = group
  mocks.clone.mockResolvedValue('commit123')
  mocks.index.mockResolvedValue('ready')
})
describe('microservice groups and preparation', () => {
  it('does not disclose a group outside the user scope', async () => {
    mocks.selectRows = [[]]
    await expect(ownedMicroserviceGroup('group', 'stranger')).rejects.toThrow('not found')
    const query = new PgDialect().sqlToQuery(mocks.conditions[0] as Parameters<PgDialect['sqlToQuery']>[0])
    expect(query.params).toEqual(['group', 'stranger'])
  })
  it('rejects duplicate projects before writing or cloning anything', async () => {
    await expect(saveMicroserviceGroup({ name: 'Bad', description: '', codegraphEnabled: true, projects: [group.projects[0]!, group.projects[0]!] }, { id: 'owner', username: 'owner' })).rejects.toThrow('only once')
    expect(mocks.updates).toEqual([])
    expect(mocks.clone).not.toHaveBeenCalled()
  })
  it('prepares sibling checkouts before indexing the common root', async () => {
    mocks.selectRows = [[group], repos]
    await processMicroserviceWorkspaces()
    expect(mocks.clone).toHaveBeenCalledWith('/tmp/group', 'api', '/tmp/api', 'main')
    expect(mocks.clone).toHaveBeenCalledWith('/tmp/group', 'gateway', '/tmp/gateway', 'main')
    expect(mocks.manifest).toHaveBeenCalledWith('/tmp/group', 'Avat', 'Platform', expect.arrayContaining([expect.objectContaining({ directory: 'api', labels: ['backend'], commit: 'commit123' })]))
    expect(mocks.index).toHaveBeenCalledWith('/tmp/group', true)
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'ready', codegraphStatus: 'ready' }))
  })
  it('makes repository chat ready before the CodeGraph index finishes', async () => {
    mocks.selectRows = [[group], repos]
    let finishIndex!: (value: string) => void
    mocks.index.mockImplementationOnce(() => new Promise<string>(resolve => { finishIndex = resolve }))
    const preparing = processMicroserviceWorkspaces()
    await vi.waitFor(() => expect(mocks.index).toHaveBeenCalled())
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'ready', codegraphStatus: 'indexing' }))
    finishIndex('ready')
    await preparing
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'ready', codegraphStatus: 'ready' }))
  })
  it('clones selected projects concurrently rather than waiting for each checkout', async () => {
    mocks.selectRows = [[group], repos]
    const complete: Array<(value: string) => void> = []
    mocks.clone.mockImplementationOnce(() => new Promise<string>(resolve => complete.push(resolve)))
      .mockImplementationOnce(() => new Promise<string>(resolve => complete.push(resolve)))
    const preparing = processMicroserviceWorkspaces()
    await vi.waitFor(() => expect(complete).toHaveLength(2))
    complete.forEach(resolve => resolve('commit123'))
    await preparing
    expect(mocks.updates.at(-1)?.workspaceStatus).toBe('ready')
  })
  it('retries only CodeGraph without fetching or recloning any repository', async () => {
    mocks.selectRows = [[{ ...group, workspaceStatus: 'ready', codegraphStatus: 'queued' }]]
    await processMicroserviceWorkspaces()
    expect(mocks.clone).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.index).toHaveBeenCalledWith('/tmp/group', true)
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'ready', codegraphStatus: 'ready' }))
    expect(mocks.updates.at(-1)).not.toHaveProperty('preparedAt')
  })
  it('waits for missing source clones without indexing a partial workspace', async () => {
    mocks.selectRows = [[group], [repos[0], { ...repos[1], workspaceStatus: 'not_cloned', localPath: null }]]
    await processMicroserviceWorkspaces()
    expect(mocks.ensure).toHaveBeenCalled()
    expect(mocks.clone).not.toHaveBeenCalled()
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'waiting' }))
  })
  it('reports clone failures and keeps preparation retryable', async () => {
    mocks.selectRows = [[group], repos]
    mocks.clone.mockRejectedValueOnce(new Error('Clone failed'))
    await processMicroserviceWorkspaces()
    expect(mocks.index).not.toHaveBeenCalled()
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'failed', lastError: 'Clone failed' }))
  })
  it('uses snapshots when CodeGraph fails and reports that limitation', async () => {
    mocks.selectRows = [[group], repos]
    mocks.index.mockRejectedValueOnce(new Error('CodeGraph missing'))
    await processMicroserviceWorkspaces()
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'ready', codegraphStatus: 'unavailable', lastError: expect.stringContaining('CodeGraph missing') }))
  })
  it('stops retrying failed source clones until the user requests another preparation', async () => {
    mocks.selectRows = [[{ ...group, workspaceStatus: 'waiting' }], [repos[0], { ...repos[1], workspaceStatus: 'failed' }]]
    await processMicroserviceWorkspaces()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.updates.at(-1)).toEqual(expect.objectContaining({ workspaceStatus: 'failed', lastError: expect.stringContaining('Gateway') }))
  })
})
