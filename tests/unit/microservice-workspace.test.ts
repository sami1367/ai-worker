import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { microserviceGroupSchema } from '../../shared/microservices'
import { projectDirectories, syncMicroserviceClone, writeMicroserviceManifest } from '../../server/services/microservice-workspace'
const exec = promisify(execFile)
let temporary = ''
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); temporary = '' })
const projectA = '11111111-1111-4111-8111-111111111111'
const projectB = '22222222-2222-4222-8222-222222222222'
describe('microservice workspaces', () => {
  it('requires multiple distinct projects and bounds descriptions and labels', () => {
    const input = { name: 'Avat', projects: [{ repositoryId: projectA }, { repositoryId: projectB }] }
    expect(microserviceGroupSchema.safeParse(input).success).toBe(true)
    expect(microserviceGroupSchema.safeParse({ ...input, projects: input.projects.slice(0, 1) }).success).toBe(false)
    expect(microserviceGroupSchema.safeParse({ ...input, projects: [input.projects[0], input.projects[0]] }).success).toBe(false)
    expect(microserviceGroupSchema.safeParse({ ...input, projects: [{ repositoryId: projectA, labels: ['a'.repeat(41)] }, input.projects[1]] }).success).toBe(false)
  })
  it('creates readable, unique directory names without path traversal', () => {
    const directories = projectDirectories([
      { repositoryId: projectA, name: 'org/api' }, { repositoryId: projectB, name: 'other/api' },
      { repositoryId: 'third', name: '../..' },
    ])
    expect(directories).toEqual(['api', `api-${projectB}`, 'service'])
    expect(new Set(directories).size).toBe(directories.length)
    const collisions = projectDirectories([
      { repositoryId: projectA, name: `api-${projectB}` },
      { repositoryId: 'third', name: 'api' },
      { repositoryId: projectB, name: 'api' },
    ])
    expect(new Set(collisions).size).toBe(3)
  })
  it('clones sibling repositories independently and refreshes only the requested checkout', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'aiw-group-test-'))
    const source = join(temporary, 'source')
    const root = join(temporary, 'group')
    await mkdir(source)
    await exec('git', ['init', '-b', 'main', source])
    await exec('git', ['-C', source, 'config', 'user.email', 'test@example.com'])
    await exec('git', ['-C', source, 'config', 'user.name', 'Test'])
    await writeFile(join(source, 'service.ts'), 'export const version = 1\n')
    await exec('git', ['-C', source, 'add', '.'])
    await exec('git', ['-C', source, 'commit', '-m', 'Initial'])
    const first = await syncMicroserviceClone(root, 'api', source, 'main')
    const fetchHead = join(root, 'api', '.git', 'FETCH_HEAD')
    await writeFile(fetchHead, 'no redundant fetch')
    expect(await syncMicroserviceClone(root, 'api', source, 'main')).toBe(first)
    expect(await readFile(fetchHead, 'utf8')).toBe('no redundant fetch')
    await syncMicroserviceClone(root, 'gateway', source, 'main')
    await writeFile(join(source, 'service.ts'), 'export const version = 2\n')
    await exec('git', ['-C', source, 'commit', '-am', 'Update'])
    const next = await syncMicroserviceClone(root, 'api', source, 'main')
    expect(next).not.toBe(first)
    expect(await readFile(join(root, 'api/service.ts'), 'utf8')).toContain('version = 2')
    expect(await readFile(join(root, 'gateway/service.ts'), 'utf8')).toContain('version = 1')
    expect(await readFile(join(source, 'service.ts'), 'utf8')).toContain('version = 2')
    await expect(syncMicroserviceClone(root, '../escape', source, 'main')).rejects.toThrow('Invalid service directory')
  })
  it('writes role metadata and prunes removed services from the group manifest only', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'aiw-group-manifest-'))
    const makeProject = (directory: string) => ({ repositoryId: projectA, directory, name: directory, labels: ['backend'], description: 'HTTP API', commit: 'abc' })
    await mkdir(join(temporary, 'old-api'))
    await mkdir(join(temporary, 'untracked-folder'))
    await writeMicroserviceManifest(temporary, 'Avat', 'Platform', [makeProject('old-api')])
    await writeMicroserviceManifest(temporary, 'Avat', 'Platform', [makeProject('api')])
    expect(await readFile(join(temporary, 'README.md'), 'utf8')).toContain('api/ — api; labels: backend')
    await expect(readFile(join(temporary, 'old-api/file'))).rejects.toThrow()
    expect(JSON.parse(await readFile(join(temporary, 'services.json'), 'utf8')).projects[0].directory).toBe('api')
    const { stat } = await import('node:fs/promises')
    expect((await stat(join(temporary, 'untracked-folder'))).isDirectory()).toBe(true)
  })
})
