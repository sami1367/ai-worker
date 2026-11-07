import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexMicroserviceWorkspace } from '../../server/services/microservice-workspace'
const mocks = vi.hoisted(() => ({ run: vi.fn(), statuses: [] as unknown[], failSync: false }))
vi.mock('#services/codegraph-process', () => ({ runCodegraph: mocks.run }))
let root = ''
const healthy = { initialized: true, lastIndexed: '2026-11-07T00:00:00Z', index: { state: 'complete', pendingRefs: 0 } }
const commands = () => mocks.run.mock.calls.map(call => call[0][0])
beforeEach(async () => {
  mocks.run.mockReset(); mocks.statuses = []; mocks.failSync = false
  mocks.run.mockImplementation(async (args: string[]) => {
    if (args[0] === 'status') return { stdout: JSON.stringify(mocks.statuses.shift() || healthy), stderr: '' }
    if (args[0] === 'sync' && mocks.failSync) throw new Error('Stale index')
    return { stdout: '', stderr: '' }
  })
  root = await mkdtemp(join(tmpdir(), 'aiw-group-index-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
describe('group CodeGraph indexing', () => {
  it('initializes a new group and verifies the resulting index', async () => {
    mocks.statuses = [{ initialized: false }]
    await indexMicroserviceWorkspace(root, true)
    expect(commands()).toEqual(['status', 'init', 'status'])
  })
  it('reinitializes an interrupted setup even when the .codegraph folder already exists', async () => {
    await mkdir(join(root, '.codegraph'))
    mocks.statuses = [{ initialized: false }]
    await indexMicroserviceWorkspace(root, true)
    expect(commands()).toContain('init')
  })
  it('syncs a healthy existing index instead of rebuilding it', async () => {
    await indexMicroserviceWorkspace(root, true)
    expect(commands()).toEqual(['status', 'sync', 'status'])
  })
  it('repairs an interrupted index before marking the graph ready', async () => {
    mocks.statuses = [{ ...healthy, index: { state: 'indexing' } }]
    await indexMicroserviceWorkspace(root, true)
    expect(commands()).toEqual(['status', 'index', 'status'])
  })
  it('repairs the index with a full rebuild when incremental sync fails', async () => {
    mocks.failSync = true
    await expect(indexMicroserviceWorkspace(root, true)).resolves.toBe('ready')
    expect(commands()).toEqual(['status', 'sync', 'index', 'status'])
  })
  it('does not report ready if the build never completed and saves the diagnostics', async () => {
    mocks.statuses = [{ initialized: false }, { initialized: true, lastIndexed: null }, { initialized: true, lastIndexed: null }]
    await expect(indexMicroserviceWorkspace(root, true)).rejects.toThrow('did not finish successfully')
    expect(await readFile(join(root, '.codegraph-preparation.log'), 'utf8')).toContain('codegraph index')
  })
  it('never mistakes a parent directory index for the group index', async () => {
    mocks.statuses = [{ ...healthy, projectPath: tmpdir() }]
    await indexMicroserviceWorkspace(root, true)
    expect(commands()).toContain('init')
  })
})
