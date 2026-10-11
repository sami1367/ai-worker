import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { managedWorkspacePath, newWorkspaceId } from '../../server/utils/paths'

describe('workspace identity and path safety', () => {
  let root: string
  const prev = process.env.WORKSPACE_ROOT

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiw-ws-'))
    process.env.WORKSPACE_ROOT = root
  })

  afterEach(async () => {
    process.env.WORKSPACE_ROOT = prev
    await rm(root, { recursive: true, force: true })
  })

  it('creates collision-resistant workspace ids', () => {
    const a = newWorkspaceId()
    const b = newWorkspaceId()
    expect(a).toMatch(/^[a-f0-9]{16}$/)
    expect(a).not.toBe(b)
  })

  it('keeps resolved paths inside the workspace root', async () => {
    const id = 'abcd1234efgh5678'
    const path = managedWorkspacePath(id)
    expect(path.startsWith(root)).toBe(true)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'marker'), 'ok')
  })

  it('rejects path traversal workspace ids', () => {
    expect(() => managedWorkspacePath('../outside')).toThrow()
    expect(() => managedWorkspacePath('a/b')).toThrow()
    expect(() => managedWorkspacePath('a;rm -rf')).toThrow()
  })
})
