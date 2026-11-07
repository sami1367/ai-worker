import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { chatWorkRuns } from '#db/schema'
import { getDb } from '#utils/db'
import { AppError } from '#utils/errors'
import { redactSecrets } from '#utils/redact'
import { workerBaseDir } from '#utils/paths'
import { ACTIVE_WORK_STATUSES, type ChatWorkResult } from '#shared/chat-work'
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildChatWorkPrompt, chatWorkBranch, chatWorkChanges, chatWorkDirectory, chatWorkGit, commitChatWork, prepareChatWorkClone, pushChatWorkBranch, restoreChatWorkGitConfig } from './chat-work-git'
import { getConnectionAccessToken } from './connections'
import { openChatGitHubPullRequest } from './forge-github'
import { openChatGitLabMergeRequest } from './forge-gitlab'

const LEASE_MS = 180_000
export function chatWorkArtifacts(id: string) { return join(process.env.LOGS_DIR || join(workerBaseDir(), 'logs'), 'chat-work', id) }
export async function recoverExpiredChatWork() {
  await getDb().update(chatWorkRuns).set({ status: 'interrupted', errorSummary: 'Worker connection was lost. Generated changes are retained. Retry publishing if implementation finished, or generate a new plan.', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(chatWorkRuns.status, ACTIVE_WORK_STATUSES.filter(status => status !== 'queued')), lt(chatWorkRuns.leaseExpiresAt, new Date())))
}
export async function claimChatWork(workerId: string) {
  await recoverExpiredChatWork()
  return getDb().transaction(async tx => {
    const [run] = await tx.select().from(chatWorkRuns).where(eq(chatWorkRuns.status, 'queued')).orderBy(asc(chatWorkRuns.createdAt)).for('update', { skipLocked: true }).limit(1)
    if (!run) return { run: null }
    const leaseToken = randomUUID()
    await tx.update(chatWorkRuns).set({ status: 'preparing', workerId, leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS), startedAt: run.startedAt || new Date(), updatedAt: new Date() }).where(eq(chatWorkRuns.id, run.id))
    return { run: { id: run.id, leaseToken, publishOnly: Boolean(run.agentCompletedAt) } }
  })
}
async function leasedRun(id: string, leaseToken: string) {
  const [run] = await getDb().select().from(chatWorkRuns).where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), inArray(chatWorkRuns.status, ACTIVE_WORK_STATUSES))).limit(1)
  if (!run) throw new AppError(409, 'Work lease is no longer active', 'work_lease_lost')
  return run
}
export async function heartbeatChatWork(id: string, leaseToken: string) {
  const [updated] = await getDb().update(chatWorkRuns).set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
    .where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), inArray(chatWorkRuns.status, ACTIVE_WORK_STATUSES))).returning({ id: chatWorkRuns.id })
  if (!updated) throw new AppError(409, 'Work lease is no longer active', 'work_lease_lost')
  return { ok: true }
}
export async function prepareChatWork(id: string, leaseToken: string) {
  const run = await leasedRun(id, leaseToken)
  if (run.status !== 'preparing') throw new AppError(409, 'Work is already prepared', 'work_conflict')
  const workspace = chatWorkDirectory(id)
  const artifacts = chatWorkArtifacts(id)
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(artifacts, { recursive: true, mode: 0o700 })
    if (!run.agentCompletedAt) {
      for (const repo of run.repositorySnapshot) {
        const path = await prepareChatWorkClone(workspace, repo, id)
        await copyFile(join(path, '.git', 'config'), join(artifacts, `${repo.id}.gitconfig`))
      }
      await writeFile(join(workspace, 'SERVICES.md'), run.repositorySnapshot.map(repo => `- ${repo.directory}/: ${repo.name} [${repo.labels.join(', ')}] ${repo.description}`).join('\n'))
      await writeFile(join(artifacts, 'prompt.txt'), buildChatWorkPrompt(run.title, run.tasks, run.repositorySnapshot), { mode: 0o600 })
    }
    await getDb().update(chatWorkRuns).set({ status: 'running', updatedAt: new Date() }).where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), eq(chatWorkRuns.status, 'preparing')))
    return { workspace, promptFile: join(artifacts, 'prompt.txt'), stdoutLog: join(artifacts, 'agent.ndjson'), stderrLog: join(artifacts, 'agent.stderr.log'), runnerLog: join(artifacts, 'runner.log'), provider: run.provider, codegraphEnabled: run.codegraphEnabled, publishOnly: Boolean(run.agentCompletedAt) }
  } catch (error) {
    await failRun(id, leaseToken, error)
    throw new AppError(409, 'Could not prepare the approved workspace. See the work run for details.', 'workspace_failed')
  }
}
async function failRun(id: string, leaseToken: string, error: unknown) {
  await getDb().update(chatWorkRuns).set({ status: 'failed', errorSummary: redactSecrets(error instanceof Error ? error.message : 'Work failed').slice(0, 2000), finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), inArray(chatWorkRuns.status, ACTIVE_WORK_STATUSES)))
}
export async function completeChatWork(id: string, leaseToken: string, exitCode: number) {
  const run = await leasedRun(id, leaseToken)
  if (run.status === 'publishing') return { status: 'publishing' }
  if (run.status !== 'running') throw new AppError(409, 'Work is not running', 'work_conflict')
  if (exitCode !== 0) {
    await failRun(id, leaseToken, new Error(`Coding agent exited with code ${exitCode}. Review the run log; no PR/MR was published.`))
    return { status: 'failed' }
  }
  const [claimed] = await getDb().update(chatWorkRuns).set({ status: 'publishing', agentCompletedAt: run.agentCompletedAt || new Date(), leaseExpiresAt: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
    .where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), eq(chatWorkRuns.status, 'running'))).returning()
  if (!claimed) throw new AppError(409, 'Work changed while finishing', 'work_conflict')
  void publishChatWork(claimed).catch(error => failRun(id, leaseToken, error).catch(() => {}))
  return { status: 'publishing' }
}
async function publishChatWork(run: typeof chatWorkRuns.$inferSelect) {
  const id = run.id
  const leaseToken = run.leaseToken!
  let leaseLost = false
  const timer = setInterval(() => { void heartbeatChatWork(id, leaseToken).catch(() => { leaseLost = true }) }, 15_000)
  timer.unref?.()
  const results = [...run.results]
  const saveResult = async (result: ChatWorkResult) => {
    const index = results.findIndex(item => item.repositoryId === result.repositoryId)
    if (index >= 0) results[index] = result
    else results.push(result)
    await getDb().update(chatWorkRuns).set({ results: [...results], updatedAt: new Date() }).where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), eq(chatWorkRuns.status, 'publishing')))
  }
  try {
    const affected = new Set(run.tasks.flatMap(task => task.repositoryIds))
    const root = chatWorkDirectory(id)
    for (const repo of run.repositorySnapshot) await restoreChatWorkGitConfig(join(root, repo.directory), join(chatWorkArtifacts(id), `${repo.id}.gitconfig`))
    // Fail the whole run before any publishing if the agent touched a context-only repository.
    for (const repo of run.repositorySnapshot.filter(repo => !affected.has(repo.id))) {
      const path = join(root, repo.directory)
      if (await chatWorkChanges(path) || await chatWorkGit(path, ['rev-parse', 'HEAD']) !== repo.baseCommit) throw new Error(`Agent changed context-only repository ${repo.name}. No new requests were published. Review the workspace.`)
    }
    for (const repo of run.repositorySnapshot.filter(repo => affected.has(repo.id))) {
      if (leaseLost) throw new Error('Work lease was lost before publishing')
      const previous = results.find(result => result.repositoryId === repo.id)
      if (previous?.status === 'created' || previous?.status === 'no_changes') continue
      const result: ChatWorkResult = { repositoryId: repo.id, name: repo.name, branch: chatWorkBranch(id), status: 'pending', tree: previous?.tree, commit: previous?.commit }
      try {
        const path = join(root, repo.directory)
        const committed = await commitChatWork(path, repo, id, run.title, result.tree, async tree => { result.tree = tree; await saveResult({ ...result }) })
        if (!committed) { await saveResult({ ...result, status: 'no_changes' }); continue }
        result.commit = committed.commit
        result.tree = committed.tree
        await saveResult({ ...result })
        const { token, row: connection } = await getConnectionAccessToken(repo.connectionId)
        if (connection.provider !== repo.forgeType) throw new Error('Forge connection type changed')
        await leasedRun(id, leaseToken)
        await pushChatWorkBranch(path, repo, id, token)
        const chatLink = `${(process.env.APP_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}${run.chatUrl}`
        const body = [`## Local chat work`, `[Conversation](${chatLink}) · Work run ${id}`,
          ...run.tasks.filter(task => task.repositoryIds.includes(repo.id)).map(task => `### ${task.title}\n${task.body}`),
          '## Implementation log', 'See the Chat Work run in AI Worker for the agent output and test results.',
        ].join('\n\n')
        result.url = repo.forgeType === 'github'
          ? await openChatGitHubPullRequest({ token, fullName: repo.fullName, branch: result.branch, targetBranch: repo.targetBranch, title: run.title, body })
          : await openChatGitLabMergeRequest({ token, instanceUrl: connection.instanceUrl || repo.instanceUrl || 'https://gitlab.com', project: repo.fullName, branch: result.branch, targetBranch: repo.targetBranch, title: run.title, body })
        await saveResult({ ...result, status: 'created' })
      } catch (error) {
        await saveResult({ ...result, status: 'failed', error: redactSecrets(error instanceof Error ? error.message : 'Publishing failed').slice(0, 1500) })
      }
    }
    const failed = results.filter(result => result.status === 'failed')
    const created = results.filter(result => result.status === 'created')
    const status = failed.length ? (created.length ? 'partial' : 'failed') : created.length ? 'succeeded' : 'no_changes'
    await getDb().update(chatWorkRuns).set({ status, errorSummary: failed.length ? 'Some repositories could not be published. Review their errors and retry publishing.' : null, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(chatWorkRuns.id, id), eq(chatWorkRuns.leaseToken, leaseToken), eq(chatWorkRuns.status, 'publishing')))
  } finally { clearInterval(timer) }
}
export async function chatWorkLog(id: string) {
  const chunks = []
  for (const name of ['runner.log', 'agent.stderr.log']) {
    try {
      const file = await open(join(chatWorkArtifacts(id), name), 'r')
      try {
        const size = (await file.stat()).size
        const buffer = Buffer.alloc(Math.min(size, 64_000))
        await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length))
        chunks.push(`${name}\n${buffer.toString('utf8')}`)
      } finally { await file.close() }
    } catch { /* logs may not exist before the agent starts */ }
  }
  return redactSecrets(chunks.join('\n\n'))
}

let recoveryTimer: ReturnType<typeof setInterval> | null = null
export function startChatWorkRecovery() {
  if (recoveryTimer) return
  recoveryTimer = setInterval(() => { void recoverExpiredChatWork().catch(() => {}) }, 60_000)
  recoveryTimer.unref?.()
}
