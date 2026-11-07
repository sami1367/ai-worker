import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildChatWorkPrompt, chatWorkBranch, chatWorkChanges, chatWorkGit, commitChatWork, prepareChatWorkClone, restoreChatWorkGitConfig } from '../../server/services/chat-work-git'
import type { ChatWorkRepository } from '../../shared/chat-work'
const exec = promisify(execFile)
let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'aiw-chat-work-git-'))
  const source = join(root, 'source'); const workspace = join(root, 'run')
  await mkdir(source); await mkdir(workspace)
  await exec('git', ['init', '-b', 'main', source])
  await exec('git', ['-C', source, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', source, 'config', 'user.email', 'test@example.com'])
  await writeFile(join(source, 'api.ts'), 'export const version = 1\n')
  await exec('git', ['-C', source, 'add', '.']); await exec('git', ['-C', source, 'commit', '-m', 'Initial'])
  const baseCommit = (await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()
  const repo: ChatWorkRepository = { id: 'repo', name: 'API', directory: 'api', sourcePath: source, baseCommit,
    remoteUrl: 'https://github.com/org/api.git', fullName: 'org/api', forgeType: 'github', instanceUrl: null, connectionId: 'connection', targetBranch: 'main', labels: ['backend'], description: '' }
  const path = await prepareChatWorkClone(workspace, repo, 'run-id')
  return { source, workspace, repo, path }
}
describe('chat work Git orchestration', () => {
  it('creates an independent branch with no publishing remote and leaves source untouched', async () => {
    const { repo, path, source } = await fixture()
    expect(await chatWorkGit(path, ['branch', '--show-current'])).toBe(chatWorkBranch('run-id'))
    expect(await chatWorkGit(path, ['remote'])).toBe('')
    expect(await chatWorkGit(source, ['rev-parse', 'HEAD'])).toBe(repo.baseCommit)
    await writeFile(join(path, 'api.ts'), 'export const version = 2\n')
    expect(await readFile(join(source, 'api.ts'), 'utf8')).toContain('version = 1')
  })
  it('commits all approved changes once, ignores CodeGraph artifacts, and recovers the same commit on publish retry', async () => {
    const { repo, path } = await fixture()
    await writeFile(join(path, 'api.ts'), 'export const version = 2\n')
    await mkdir(join(path, '.codegraph')); await writeFile(join(path, '.codegraph', 'index'), 'internal data')
    let stagedTree = ''
    const first = await commitChatWork(path, repo, 'run-id', 'Update API', undefined, async tree => { stagedTree = tree })
    expect(first?.tree).toBe(stagedTree)
    expect(await chatWorkGit(path, ['show', '--name-only', '--format=', 'HEAD'])).toBe('api.ts')
    const retry = await commitChatWork(path, repo, 'run-id', 'Update API', stagedTree, async () => {})
    expect(retry).toEqual(first)
    expect(await chatWorkGit(path, ['rev-list', '--count', `${repo.baseCommit}..HEAD`])).toBe('1')
  })
  it('does not create empty commits or PR candidates for unchanged repositories', async () => {
    const { repo, path } = await fixture()
    expect(await commitChatWork(path, repo, 'run-id', 'No changes', undefined, async () => {})).toBeNull()
    expect(await chatWorkChanges(path)).toBe('')
  })
  it('rejects agent-created commits before trusted publication', async () => {
    const { repo, path } = await fixture()
    await writeFile(join(path, 'api.ts'), 'export const version = 2\n')
    await chatWorkGit(path, ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-am', 'Unexpected commit'])
    await expect(commitChatWork(path, repo, 'run-id', 'Update', undefined, async () => {})).rejects.toThrow('history changed')
  })
  it('restores trusted Git configuration and rejects replaced metadata before publishing', async () => {
    const { path } = await fixture()
    const saved = join(root, 'trusted.gitconfig')
    const config = join(path, '.git', 'config')
    const original = await readFile(config)
    await writeFile(saved, original)
    await writeFile(config, '[core]\nworktree = /unexpected\n')
    await restoreChatWorkGitConfig(path, saved)
    expect(await readFile(config)).toEqual(original)
    await rm(config)
    await symlink(saved, config)
    await expect(restoreChatWorkGitConfig(path, saved)).rejects.toThrow('configuration was replaced')
  })
  it('gives the agent cross-service context while restricting edits to planned repositories', () => {
    const repos = [{ id: 'api', directory: 'api', name: 'API', labels: ['backend'], description: '' }, { id: 'gateway', directory: 'gateway', name: 'Gateway', labels: ['gateway'], description: '' }] as ChatWorkRepository[]
    const prompt = buildChatWorkPrompt('Update', [{ id: 'task', title: 'Fix API', body: 'Add tests', repositoryIds: ['api'] }], repos)
    expect(prompt).toContain('api/: API [backend]  — EDIT')
    expect(prompt).toContain('gateway/: Gateway [gateway]  — READ ONLY CONTEXT')
    expect(prompt).toContain('Do not create issues, push branches, commit')
  })
})
