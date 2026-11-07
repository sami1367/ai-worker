import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRepoCodeContext } from '../../server/services/task-planning-context'
const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: mocks.exec }))
let root = ''
beforeEach(async () => {
  mocks.exec.mockReset()
  mocks.exec.mockImplementation((_command: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string }) => void) => {
    if (args.includes('--json')) callback(new Error('unknown option --json'))
    else callback(null, { stdout: 'Found getAccount in api/handler.ts and routeRequest in gateway/router.ts' })
  })
  root = await mkdtemp(join(tmpdir(), 'aiw-graph-context-'))
  await mkdir(join(root, '.codegraph'))
  await writeFile(join(root, 'README.md'), '# Group')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
describe('live CodeGraph context', () => {
  it('uses the supported explore CLI and includes source results in model context', async () => {
    const result = await buildRepoCodeContext({ localPath: root, workspaceStatus: 'ready', codegraphEnabled: true, epicHint: 'getAccount routeRequest' })
    expect(result.summary).toContain('api/handler.ts')
    expect(result.summary).toContain('gateway/router.ts')
    expect(result.summary).toContain('CodeGraph explore (live)')
  })
  it('skips CodeGraph when it is disabled', async () => {
    const result = await buildRepoCodeContext({ localPath: root, workspaceStatus: 'ready', codegraphEnabled: false })
    expect(result.available).toBe(true)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
