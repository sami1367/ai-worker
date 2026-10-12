import { access, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { repositories, workspaceOperations } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { managedWorkspacePath, workspaceRootFromEnv } from '#utils/paths'
import { newCorrelationId } from '#utils/crypto'
import { redactSecrets } from '#utils/redact'
import { authenticatedCloneUrl } from './forge-credentials'
import { getConnectionAccessToken } from './connections'
import { exportWorkerConfig } from './config-sync'
import { writeAudit } from './audit'

const execFileAsync = promisify(execFile)

const inFlight = new Set<string>()
let workerTimer: ReturnType<typeof setInterval> | null = null

function originsMatch(a: string, b: string): boolean {
  const norm = (u: string) => u
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase()
    .replace(/^https?:\/\/[^@]+@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
  return norm(a) === norm(b)
}

async function runGit(args: string[], opts: { cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
      env: {
        ...process.env,
        ...opts.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
      maxBuffer: 2 * 1024 * 1024,
    })
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: unknown, stderr?: unknown, message?: string, code?: unknown }
    const stdout = String(e.stdout || '')
    const stderr = String(e.stderr || e.message || 'git failed')
    const code = typeof e.code === 'number' ? e.code : 1
    return { stdout, stderr, code }
  }
}

export async function queueWorkspaceOperation(opts: {
  repositoryId: string
  operationType: 'clone' | 'sync' | 'verify' | 'delete_workspace'
  actor: { id?: string | null, username: string }
}) {
  const db = getDb()
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, opts.repositoryId)).limit(1)
  if (!repo || repo.isArchived) throw new AppError(404, 'Repository not found', 'not_found')

  const [existing] = await db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.repositoryId, opts.repositoryId),
    inArray(workspaceOperations.status, ['queued', 'running']),
  )).limit(1)
  if (existing) {
    return existing
  }

  const requestedBy = opts.actor.id && /^[0-9a-f-]{36}$/i.test(opts.actor.id)
    ? opts.actor.id
    : null

  const [op] = await db.insert(workspaceOperations).values({
    repositoryId: opts.repositoryId,
    operationType: opts.operationType,
    status: 'queued',
    requestedBy,
    correlationId: newCorrelationId(),
  }).returning()

  const nextStatus = opts.operationType === 'sync'
    ? 'syncing' as const
    : opts.operationType === 'clone'
      ? 'queued' as const
      : repo.workspaceStatus
  await db.update(repositories).set({
    workspaceStatus: opts.operationType === 'clone' ? 'queued' : nextStatus,
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(repositories.id, opts.repositoryId))

  await writeAudit({
    actorUserId: requestedBy,
    actorUsername: opts.actor.username,
    action: `workspace.${opts.operationType}_queued`,
    targetType: 'repository',
    targetId: opts.repositoryId,
    metadata: { operationId: op.id },
  })

  // Kick the processor without awaiting long work in the request path
  void processWorkspaceQueue()
  return op
}

/**
 * Ensure a managed workspace exists for the worker before an AI job runs.
 * Lookup prefers localPath (unique per repo), then name+forgeType.
 * Queues a clone when needed and returns current status (worker polls).
 */
export async function ensureWorkspaceForWorker(input: {
  path?: string
  name?: string
  forgeType?: 'github' | 'gitlab'
  fullName?: string
}) {
  const db = getDb()

  if (!input.path && !input.name && !input.fullName) {
    throw new AppError(400, 'path, name, or fullName is required', 'invalid_request')
  }

  let repo: typeof repositories.$inferSelect | undefined

  if (input.path) {
    const [byPath] = await db.select().from(repositories).where(and(
      eq(repositories.isArchived, false),
      eq(repositories.localPath, input.path),
    )).limit(1)
    repo = byPath
  }

  if (!repo && input.fullName) {
    const [byFull] = await db.select().from(repositories).where(and(
      eq(repositories.isArchived, false),
      eq(repositories.canonicalProjectIdentifier, input.fullName),
      ...(input.forgeType ? [eq(repositories.forgeType, input.forgeType)] : []),
    )).limit(1)
    repo = byFull
  }

  if (!repo && input.name) {
    const [byName] = await db.select().from(repositories).where(and(
      eq(repositories.isArchived, false),
      eq(repositories.name, input.name),
      ...(input.forgeType ? [eq(repositories.forgeType, input.forgeType)] : []),
    )).limit(1)
    repo = byName
  }

  if (!repo) throw new AppError(404, 'Repository not found', 'not_found')

  // Already ready and checkout present
  if (repo.localPath) {
    try {
      await access(join(repo.localPath, '.git'))
      if (repo.workspaceStatus !== 'ready') {
        await db.update(repositories).set({
          workspaceStatus: 'ready',
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(repositories.id, repo.id))
      }
      return {
        repositoryId: repo.id,
        localPath: repo.localPath,
        workspaceStatus: 'ready' as const,
        operationId: null as string | null,
      }
    } catch {
      // Fall through to (re)clone
    }
  }

  if (['queued', 'cloning', 'syncing'].includes(repo.workspaceStatus)) {
    const [op] = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.repositoryId, repo.id),
      inArray(workspaceOperations.status, ['queued', 'running']),
    )).limit(1)
    // Kick processor in case timer stalled
    void processWorkspaceQueue()
    return {
      repositoryId: repo.id,
      localPath: repo.localPath,
      workspaceStatus: repo.workspaceStatus,
      operationId: op?.id ?? null,
    }
  }

  const op = await queueWorkspaceOperation({
    repositoryId: repo.id,
    operationType: 'clone',
    actor: { username: 'worker' },
  })

  return {
    repositoryId: repo.id,
    localPath: repo.localPath,
    workspaceStatus: 'queued' as const,
    operationId: op.id,
  }
}

export async function listWorkspaceOperations(repositoryId: string, limit = 20) {
  const db = getDb()
  return db.select().from(workspaceOperations)
    .where(eq(workspaceOperations.repositoryId, repositoryId))
    .orderBy(asc(workspaceOperations.createdAt))
    .limit(limit)
    .then((rows) => rows.map((r) => ({
      ...r,
      errorSummary: r.errorSummary ? redactSecrets(r.errorSummary) : null,
      logExcerpt: r.logExcerpt ? redactSecrets(r.logExcerpt) : null,
    })).reverse())
}

export async function getWorkspaceOperation(id: string) {
  const db = getDb()
  const [row] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, id)).limit(1)
  if (!row) throw new AppError(404, 'Operation not found', 'not_found')
  return {
    ...row,
    errorSummary: row.errorSummary ? redactSecrets(row.errorSummary) : null,
    logExcerpt: row.logExcerpt ? redactSecrets(row.logExcerpt) : null,
  }
}

async function claimNextOperation() {
  const db = getDb()
  const [op] = await db.select().from(workspaceOperations)
    .where(eq(workspaceOperations.status, 'queued'))
    .orderBy(asc(workspaceOperations.createdAt))
    .limit(1)
  if (!op) return null
  if (inFlight.has(op.repositoryId)) return null

  const [claimed] = await db.update(workspaceOperations).set({
    status: 'running',
    startedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(workspaceOperations.id, op.id),
    eq(workspaceOperations.status, 'queued'),
  )).returning()

  return claimed || null
}

async function executeOperation(op: typeof workspaceOperations.$inferSelect) {
  const db = getDb()
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, op.repositoryId)).limit(1)
  if (!repo) {
    await db.update(workspaceOperations).set({
      status: 'failed',
      errorSummary: 'Repository missing',
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(workspaceOperations.id, op.id))
    return
  }

  inFlight.add(repo.id)
  const logs: string[] = []

  try {
    if (op.operationType === 'delete_workspace') {
      await deleteWorkspaceDir(repo, logs)
    } else if (op.operationType === 'verify') {
      await verifyWorkspace(repo, logs)
    } else if (op.operationType === 'sync') {
      await syncWorkspace(repo, logs)
    } else {
      await cloneWorkspace(repo, logs)
    }

    const [fresh] = await db.select().from(repositories).where(eq(repositories.id, repo.id)).limit(1)
    await db.update(workspaceOperations).set({
      status: 'succeeded',
      finishedAt: new Date(),
      logExcerpt: redactSecrets(logs.join('\n').slice(-3500)),
      updatedAt: new Date(),
    }).where(eq(workspaceOperations.id, op.id))

    if (fresh && op.operationType !== 'delete_workspace') {
      await db.update(repositories).set({
        workspaceStatus: 'ready',
        lastError: null,
        healthStatus: 'healthy',
        healthMessage: 'Workspace ready',
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(repositories.id, repo.id))
    }

    await exportWorkerConfig()
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : 'Workspace operation failed')
    logs.push(message)
    await db.update(workspaceOperations).set({
      status: 'failed',
      errorSummary: message,
      logExcerpt: redactSecrets(logs.join('\n').slice(-3500)),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(workspaceOperations.id, op.id))

    await db.update(repositories).set({
      workspaceStatus: 'failed',
      lastError: message,
      healthStatus: 'unhealthy',
      healthMessage: message,
      lastHealthCheckAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(repositories.id, repo.id))
  } finally {
    inFlight.delete(repo.id)
  }
}

async function resolveCloneAuth(repo: typeof repositories.$inferSelect) {
  if (!repo.connectionId) {
    return { token: null as string | null, authUrl: repo.remoteUrl }
  }
  const { token } = await getConnectionAccessToken(repo.connectionId)
  const authUrl = authenticatedCloneUrl(repo.remoteUrl, token, repo.forgeType)
  return { token, authUrl }
}

async function cloneWorkspace(repo: typeof repositories.$inferSelect, logs: string[]) {
  const db = getDb()
  await db.update(repositories).set({
    workspaceStatus: 'cloning',
    updatedAt: new Date(),
  }).where(eq(repositories.id, repo.id))

  const path = managedWorkspacePath(repo.workspaceId)
  const { authUrl } = await resolveCloneAuth(repo)

  let exists = false
  try {
    await access(join(path, '.git'))
    exists = true
  } catch {
    // Incomplete or missing workspace
  }

  if (exists) {
    logs.push('Workspace already present; verifying remote and fetching')
    await verifyRemote(path, repo.remoteUrl, logs)
    await fetchWorkspace(path, authUrl, repo.defaultBranch, logs)
  } else {
    // Remove incomplete directory if present
    try {
      const st = await stat(path)
      if (st.isDirectory()) {
        logs.push('Removing incomplete workspace directory')
        await rm(path, { recursive: true, force: true })
      }
    } catch {
      // missing is fine
    }

    await mkdir(workspaceRootFromEnv(), { recursive: true })
    logs.push(`Cloning into ${path}`)
    const result = await runGit([
      'clone',
      '--branch', repo.defaultBranch,
      '--single-branch',
      authUrl,
      path,
    ], { timeoutMs: 300_000 })
    logs.push(redactSecrets(result.stderr || result.stdout))
    if (result.code !== 0) {
      // Retry without branch pin if default branch missing
      const retry = await runGit(['clone', authUrl, path], { timeoutMs: 300_000 })
      logs.push(redactSecrets(retry.stderr || retry.stdout))
      if (retry.code !== 0) {
        throw new Error(`Clone failed: ${redactSecrets(retry.stderr || 'unknown error')}`)
      }
    }
    await stripRemoteCredentials(path, repo.remoteUrl, logs)
  }

  await db.update(repositories).set({
    localPath: path,
    lastCloneAt: new Date(),
    lastSyncAt: new Date(),
    workspaceStatus: 'ready',
    updatedAt: new Date(),
  }).where(eq(repositories.id, repo.id))
}

async function syncWorkspace(repo: typeof repositories.$inferSelect, logs: string[]) {
  const db = getDb()
  await db.update(repositories).set({
    workspaceStatus: 'syncing',
    updatedAt: new Date(),
  }).where(eq(repositories.id, repo.id))

  const path = repo.localPath || managedWorkspacePath(repo.workspaceId)
  try {
    await access(join(path, '.git'))
  } catch {
    logs.push('Workspace missing; performing clone')
    await cloneWorkspace(repo, logs)
    return
  }

  await verifyRemote(path, repo.remoteUrl, logs)
  const { authUrl } = await resolveCloneAuth(repo)
  await fetchWorkspace(path, authUrl, repo.defaultBranch, logs)

  await db.update(repositories).set({
    localPath: path,
    lastSyncAt: new Date(),
    workspaceStatus: 'ready',
    updatedAt: new Date(),
  }).where(eq(repositories.id, repo.id))
}

async function verifyWorkspace(repo: typeof repositories.$inferSelect, logs: string[]) {
  const path = repo.localPath || managedWorkspacePath(repo.workspaceId)
  await access(join(path, '.git'))
  await verifyRemote(path, repo.remoteUrl, logs)
  logs.push('Workspace verified')
}

async function deleteWorkspaceDir(repo: typeof repositories.$inferSelect, logs: string[]) {
  const path = managedWorkspacePath(repo.workspaceId)
  // Only delete managed path, never host-imported paths outside workspace root
  if (repo.localPath && repo.localPath !== path) {
    throw new Error('Refusing to delete non-managed workspace path')
  }
  logs.push(`Deleting workspace ${path}`)
  await rm(path, { recursive: true, force: true })
  const db = getDb()
  await db.update(repositories).set({
    workspaceStatus: 'not_cloned',
    lastError: null,
    localPath: path,
    isEnabled: false,
    updatedAt: new Date(),
  }).where(eq(repositories.id, repo.id))
  await exportWorkerConfig()
}

async function verifyRemote(path: string, expectedRemote: string, logs: string[]) {
  const result = await runGit(['remote', 'get-url', 'origin'], { cwd: path, timeoutMs: 15_000 })
  if (result.code !== 0) throw new Error('Could not read git origin')
  const origin = result.stdout.trim()
  if (!originsMatch(origin, expectedRemote)) {
    throw new Error(`Remote mismatch: workspace origin does not match registered repository`)
  }
  logs.push('Remote identity verified')
}

async function fetchWorkspace(path: string, authUrl: string, defaultBranch: string, logs: string[]) {
  // Temporarily set push URL with credentials for fetch, then restore clean URL
  await runGit(['remote', 'set-url', 'origin', authUrl], { cwd: path, timeoutMs: 10_000 })
  const fetch = await runGit(['fetch', '--prune', 'origin'], { cwd: path, timeoutMs: 180_000 })
  logs.push(redactSecrets(fetch.stderr || fetch.stdout || 'fetch complete'))
  if (fetch.code !== 0) {
    throw new Error(`Fetch failed: ${redactSecrets(fetch.stderr || 'unknown error')}`)
  }

  // Restore credential-free remote
  const clean = authUrl.replace(/\/\/[^@]+@/, '//')
  await runGit(['remote', 'set-url', 'origin', clean.endsWith('.git') ? clean : `${clean}.git`], {
    cwd: path,
    timeoutMs: 10_000,
  })

  // Do not reset hard or discard local changes — only ff-only when clean
  const dirty = await runGit(['status', '--porcelain'], { cwd: path, timeoutMs: 15_000 })
  if (dirty.stdout.trim()) {
    logs.push('Local changes present; skipped checkout/pull (safe sync)')
    return
  }

  await runGit(['checkout', defaultBranch], { cwd: path, timeoutMs: 30_000 })
  const pull = await runGit(['pull', '--ff-only', 'origin', defaultBranch], { cwd: path, timeoutMs: 120_000 })
  logs.push(redactSecrets(pull.stderr || pull.stdout || 'pull complete'))
  if (pull.code !== 0) {
    logs.push('Fast-forward pull unavailable; fetch succeeded and local branch left unchanged')
  }
}

async function stripRemoteCredentials(path: string, remoteUrl: string, logs: string[]) {
  const clean = remoteUrl.replace(/\/\/[^@]+@/, '//')
  await runGit(['remote', 'set-url', 'origin', clean], { cwd: path, timeoutMs: 10_000 })
  logs.push('Stored credential-free origin URL')
}

export async function processWorkspaceQueue() {
  // Process one at a time globally to avoid resource spikes; per-repo lock via inFlight
  for (let i = 0; i < 3; i++) {
    const op = await claimNextOperation()
    if (!op) break
    await executeOperation(op)
  }
}

export function startWorkspaceOperationWorker() {
  if (workerTimer) return
  workerTimer = setInterval(() => {
    void processWorkspaceQueue()
  }, 3000)
  // Avoid keeping the event loop alive exclusively for this timer in some runtimes
  workerTimer.unref?.()
  void processWorkspaceQueue()
}
