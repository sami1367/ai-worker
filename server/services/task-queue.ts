import { and, eq, inArray } from 'drizzle-orm'
import { repositories, taskQueueItems, taskQueueRepoSync, taskRuns } from '#db/schema'
import { getDb } from '#utils/db'
import { redactSecrets } from '#utils/redact'
import { getConnectionAccessToken } from './connections'
import { listGitHubAiIssues, listGitHubAiPullRequests } from './forge-github'
import { listGitLabAiIssues, listGitLabAiMergeRequests } from './forge-gitlab'
import { publishQueueUpdated } from './queue-events'
import { getWorkerStatus, type ActiveTask } from './worker'

export type QueuePhase =
  | 'queued'
  | 'working'
  | 'review_queued'
  | 'reviewing'
  | 'completed'
  | 'failed'

export type QueueKind = 'issue' | 'pull_request' | 'merge_request'

export type QueueTaskType =
  | 'github_issue'
  | 'gitlab_issue'
  | 'github_pr_implement'
  | 'gitlab_mr_implement'
  | 'github_pr_review'
  | 'gitlab_mr_review'

export type AssignedWorker = {
  source: 'heartbeat' | 'task_run'
  hostname?: string | null
  pid?: number | null
  repositoryName?: string | null
  taskType?: string | null
  externalId?: string | null
  branch?: string | null
  startedAt?: string | null
  runId?: string | null
}

export type QueueItem = {
  id: string
  repositoryId: string
  repositoryName: string
  forgeType: 'github' | 'gitlab'
  kind: QueueKind
  taskType: QueueTaskType
  phase: QueuePhase
  phaseLabel: string
  /** Why this item is not actively being worked (null when in progress). */
  statusReason: string | null
  externalId: string
  title: string
  url: string
  labels: string[]
  sourceBranch: string | null
  /** Branch currently associated with this work (active checkout or PR/MR head). */
  branch: string | null
  createdAt: string
  assignedWorker: AssignedWorker | null
  isNext: boolean
}

export type RepositoryQueueSummary = {
  repositoryId: string
  repositoryName: string
  forgeType: 'github' | 'gitlab'
  blockOnOpenPr: boolean
  itemCount: number
  busy: boolean
  /** Same wording as worker.log when the poller skips starting a new issue. */
  blockReason: string | null
  error: string | null
  lastSyncedAt: string | null
  items: QueueItem[]
}

type RawForgeItem = {
  kind: QueueKind
  taskType: QueueTaskType
  phase: QueuePhase
  phaseLabel: string
  externalId: string
  title: string
  url: string
  labels: string[]
  sourceBranch: string | null
  createdAt: string
}

function resolveProjectRef(repo: typeof repositories.$inferSelect): string | null {
  return repo.canonicalProjectIdentifier
    || repo.providerRepoId
    || (repo.remoteUrl
      ? repo.remoteUrl
        .replace(/\.git$/, '')
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^git@[^:]+:/, '')
      : null)
    || null
}

function lowerLabels(labels: string[]): string[] {
  return labels.map((l) => l.toLowerCase())
}

export function classifyPhase(labels: string[], kind: QueueKind): { phase: QueuePhase, phaseLabel: string, taskTypeHint: 'implement' | 'review' } {
  const set = new Set(lowerLabels(labels))

  if (kind === 'pull_request' || kind === 'merge_request') {
    if (set.has('ai-reviewing')) {
      return { phase: 'reviewing', phaseLabel: 'AI reviewing', taskTypeHint: 'review' }
    }
    if (set.has('ai-review-failed')) {
      return { phase: 'failed', phaseLabel: 'AI review failed', taskTypeHint: 'review' }
    }
    if (set.has('ai-reviewed')) {
      return { phase: 'completed', phaseLabel: 'AI reviewed', taskTypeHint: 'review' }
    }
    if (set.has('ai-review')) {
      return { phase: 'review_queued', phaseLabel: 'Queued for AI review', taskTypeHint: 'review' }
    }
  }

  if (set.has('ai-working')) {
    return { phase: 'working', phaseLabel: 'AI working', taskTypeHint: 'implement' }
  }
  if (set.has('ai-failed')) {
    return { phase: 'failed', phaseLabel: 'AI failed', taskTypeHint: 'implement' }
  }
  if (set.has('ai-answered')) {
    return { phase: 'completed', phaseLabel: 'AI answered', taskTypeHint: 'implement' }
  }
  if (set.has('ai-pr')) {
    return { phase: 'completed', phaseLabel: 'AI PR created', taskTypeHint: 'implement' }
  }
  if (set.has('ai')) {
    const queuedLabel = set.has('no-change')
      ? 'Queued for AI answer'
      : 'Queued for AI'
    return { phase: 'queued', phaseLabel: queuedLabel, taskTypeHint: 'implement' }
  }

  return { phase: 'queued', phaseLabel: 'Queued', taskTypeHint: kind === 'issue' ? 'implement' : 'review' }
}

function phaseLabelFor(phase: QueuePhase, kind: QueueKind): string {
  switch (phase) {
    case 'working': return 'AI working'
    case 'reviewing': return 'AI reviewing'
    case 'review_queued': return 'Queued for AI review'
    case 'failed': return kind === 'issue' ? 'AI failed' : 'AI review failed'
    case 'completed': return kind === 'issue' ? 'AI PR created' : 'AI reviewed'
    case 'queued': return kind === 'issue' ? 'Queued for AI' : 'Queued'
    default: return 'Queued'
  }
}

function resolveTaskType(
  forgeType: 'github' | 'gitlab',
  kind: QueueKind,
  hint: 'implement' | 'review',
): QueueTaskType {
  if (kind === 'issue') {
    return forgeType === 'github' ? 'github_issue' : 'gitlab_issue'
  }
  if (hint === 'review') {
    return forgeType === 'github' ? 'github_pr_review' : 'gitlab_mr_review'
  }
  return forgeType === 'github' ? 'github_pr_implement' : 'gitlab_mr_implement'
}

function taskTypePriority(taskType: QueueTaskType): number {
  switch (taskType) {
    case 'github_issue':
    case 'gitlab_issue':
      return 0
    case 'github_pr_implement':
    case 'gitlab_mr_implement':
      return 1
    case 'github_pr_review':
    case 'gitlab_mr_review':
      return 2
    default:
      return 9
  }
}

function matchActiveTask(
  item: Pick<QueueItem, 'repositoryName' | 'forgeType' | 'externalId' | 'taskType'>,
  active: ActiveTask,
): boolean {
  if (active.externalId && active.externalId !== item.externalId) return false
  if (active.repositoryName && active.repositoryName !== item.repositoryName) return false
  if (active.taskType && active.taskType !== item.taskType) return false
  return Boolean(active.externalId || active.repositoryName)
}

function pickAssignedWorker(
  item: Pick<QueueItem, 'repositoryId' | 'repositoryName' | 'forgeType' | 'externalId' | 'taskType'>,
  activeTasks: ActiveTask[],
  runningRuns: Array<typeof taskRuns.$inferSelect>,
  workerHost: string | null,
): AssignedWorker | null {
  const fromHeartbeat = activeTasks.find((t) => matchActiveTask(item, t))
  if (fromHeartbeat) {
    return {
      source: 'heartbeat',
      hostname: workerHost,
      pid: fromHeartbeat.pid ?? null,
      repositoryName: fromHeartbeat.repositoryName ?? item.repositoryName,
      taskType: fromHeartbeat.taskType ?? item.taskType,
      externalId: fromHeartbeat.externalId ?? item.externalId,
      branch: fromHeartbeat.branch ?? null,
      startedAt: fromHeartbeat.startedAt ?? null,
    }
  }

  const run = runningRuns.find((r) =>
    r.externalId === item.externalId
    && r.forgeType === item.forgeType
    && (r.repositoryId === item.repositoryId || !r.repositoryId),
  )
  if (run) {
    const meta = (run.resultMetadata || {}) as Record<string, unknown>
    const metaBranch = typeof meta.branch === 'string' ? meta.branch : null
    return {
      source: 'task_run',
      hostname: workerHost,
      pid: null,
      repositoryName: item.repositoryName,
      taskType: run.taskType,
      externalId: run.externalId,
      branch: metaBranch,
      startedAt: run.startedAt?.toISOString() ?? null,
      runId: run.id,
    }
  }

  return null
}

function computeNextTask(
  items: QueueItem[],
  blockOnOpenPrByRepo: Map<string, boolean>,
): QueueItem | null {
  const busyRepos = new Set(
    items
      .filter((i) => i.phase === 'working' || i.phase === 'reviewing' || i.assignedWorker)
      .map((i) => i.repositoryId),
  )

  const issueBlockedRepos = new Set<string>()
  for (const item of items) {
    if (item.kind === 'issue' && lowerLabels(item.labels).includes('ai-working')) {
      issueBlockedRepos.add(item.repositoryId)
    }
  }
  for (const [repoId, blockOn] of blockOnOpenPrByRepo) {
    if (blockOn === false) continue
    if (findBlockingOpenPrMr(items, repoId)) issueBlockedRepos.add(repoId)
  }

  const eligible = items
    .filter((i) => {
      if (i.assignedWorker) return false
      if (!(i.phase === 'queued' || i.phase === 'review_queued')) return false
      if (busyRepos.has(i.repositoryId)) return false
      if (i.kind === 'issue' && issueBlockedRepos.has(i.repositoryId)) return false
      return true
    })
    .sort((a, b) => {
      const p = taskTypePriority(a.taskType) - taskTypePriority(b.taskType)
      if (p !== 0) return p
      return a.createdAt.localeCompare(b.createdAt)
    })

  return eligible[0] ?? null
}

const IMPLEMENT_IN_FLIGHT_PR_LABELS = new Set(['ai', 'ai-working', 'ai-failed', 'ai-pr'])

/** AI issue branch naming: ai/issue-N or ai/issue-N-* (label-apply failure safety net). */
function isAiIssueBranch(branch: string | null | undefined): boolean {
  return Boolean(branch && /^ai\/issue-\d+(-|$)/.test(branch))
}

function formatPrMrRef(item: QueueItem): string {
  const ref = item.kind === 'merge_request' ? `!${item.externalId}` : `#${item.externalId}`
  const branch = item.sourceBranch || null
  const inFlightLabel = lowerLabels(item.labels).find((l) => IMPLEMENT_IN_FLIGHT_PR_LABELS.has(l))
    || (isAiIssueBranch(branch) ? 'ai-branch' : undefined)
  if (branch && inFlightLabel) return `${ref} (${branch}, ${inFlightLabel})`
  if (branch) return `${ref} (${branch})`
  if (inFlightLabel) return `${ref} (${inFlightLabel})`
  return ref
}

function isBlockingOpenPrMr(item: QueueItem): boolean {
  if (!(item.kind === 'pull_request' || item.kind === 'merge_request')) return false
  if (lowerLabels(item.labels).some((l) => IMPLEMENT_IN_FLIGHT_PR_LABELS.has(l))) return true
  return isAiIssueBranch(item.sourceBranch)
}

function findBlockingOpenPrMr(items: QueueItem[], repositoryId: string): QueueItem | null {
  const blockers = items
    .filter((i) => i.repositoryId === repositoryId && isBlockingOpenPrMr(i))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return blockers[0] ?? null
}

function findAiWorkingIssue(items: QueueItem[], repositoryId: string): QueueItem | null {
  return items.find((i) =>
    i.repositoryId === repositoryId
    && i.kind === 'issue'
    && lowerLabels(i.labels).includes('ai-working'),
  ) ?? null
}

function resolveItemBranch(item: QueueItem, allItems: QueueItem[]): string | null {
  if (item.assignedWorker?.branch) return item.assignedWorker.branch
  if (item.sourceBranch) return item.sourceBranch

  if (item.kind === 'issue' && (item.phase === 'working' || item.assignedWorker)) {
    const related = allItems.find((i) =>
      i.repositoryId === item.repositoryId
      && (i.kind === 'pull_request' || i.kind === 'merge_request')
      && i.sourceBranch
      && (
        i.sourceBranch === `ai/issue-${item.externalId}`
        || i.sourceBranch.startsWith(`ai/issue-${item.externalId}-`)
      ),
    )
    if (related?.sourceBranch) return related.sourceBranch
    return `ai/issue-${item.externalId}`
  }

  return item.branch
}

function computeRepoBlockReason(
  repo: { name: string, forgeType: 'github' | 'gitlab', blockOnOpenPr: boolean, id: string },
  items: QueueItem[],
): string | null {
  const repoItems = items.filter((i) => i.repositoryId === repo.id)
  const workingIssue = findAiWorkingIssue(repoItems, repo.id)
  if (workingIssue) {
    return `Not starting a new issue in this repo (${repo.forgeType} ${repo.name}: open issue #${workingIssue.externalId} is labeled ai-working).`
  }

  if (!repo.blockOnOpenPr) return null

  const blocker = findBlockingOpenPrMr(repoItems, repo.id)
  if (!blocker) return null

  if (repo.forgeType === 'github') {
    return `Not starting a new issue in this repo (github ${repo.name}: open AI-labeled pull request ${formatPrMrRef(blocker)}).`
  }
  return `Not starting a new issue in this repo (gitlab ${repo.name}: open AI-labeled merge request ${formatPrMrRef(blocker)}).`
}

function repoBusyItem(items: QueueItem[], repositoryId: string, excludeId?: string): QueueItem | null {
  return items.find((i) =>
    i.repositoryId === repositoryId
    && i.id !== excludeId
    && (i.phase === 'working' || i.phase === 'reviewing' || i.assignedWorker),
  ) ?? null
}

function computeStatusReason(
  item: QueueItem,
  allItems: QueueItem[],
  workerStatus: string,
  repoBlockReasonById: Map<string, string | null>,
): string | null {
  if (item.assignedWorker || item.phase === 'working' || item.phase === 'reviewing') {
    return null
  }

  const repoBlock = repoBlockReasonById.get(item.repositoryId) || null

  if (isBlockingOpenPrMr(item)) {
    const oldest = findBlockingOpenPrMr(allItems, item.repositoryId)
    if (oldest?.id === item.id && repoBlock) {
      return repoBlock
    }
  }

  if (item.kind === 'issue' && lowerLabels(item.labels).includes('ai-working') && repoBlock) {
    return repoBlock
  }

  if (item.phase === 'failed') {
    return item.kind === 'issue'
      ? 'Not working — labeled ai-failed'
      : 'Not working — labeled ai-review-failed'
  }

  if (item.phase === 'completed') {
    if (item.kind === 'issue') {
      return lowerLabels(item.labels).includes('ai-answered')
        ? 'Done — AI answered in comments (ai-answered)'
        : 'Done — AI PR/MR already created (ai-pr)'
    }
    return 'Done — AI review finished (ai-reviewed)'
  }

  if (workerStatus === 'stopped') {
    return 'Not working — worker is stopped'
  }

  if (workerStatus === 'unknown') {
    return 'Not working — worker heartbeat stale / unknown'
  }

  if (item.kind === 'issue' && item.phase === 'queued' && repoBlock) {
    return repoBlock
  }

  const busy = repoBusyItem(allItems, item.repositoryId, item.id)
  if (busy) {
    return `Not working — repository busy (#${busy.externalId} ${busy.phaseLabel.toLowerCase()})`
  }

  if (item.isNext) {
    return 'Next — waiting for worker to pick up'
  }

  if (item.phase === 'queued' || item.phase === 'review_queued') {
    return 'Not working — queued behind other eligible tasks'
  }

  return 'Not working'
}

function queueItemPublicId(
  forgeType: 'github' | 'gitlab',
  kind: QueueKind,
  repositoryId: string,
  externalId: string,
): string {
  const kindKey = kind === 'pull_request' ? 'pr' : kind === 'merge_request' ? 'mr' : 'issue'
  return `${forgeType}:${kindKey}:${repositoryId}:${externalId}`
}

async function fetchRepoForgeItems(
  repo: typeof repositories.$inferSelect,
): Promise<RawForgeItem[]> {
  if (!repo.connectionId) {
    throw new Error('Repository is not linked to a forge connection')
  }
  const projectRef = resolveProjectRef(repo)
  if (!projectRef) {
    throw new Error('Repository has no project identifier')
  }

  const { token, row: connection } = await getConnectionAccessToken(repo.connectionId)
  const items: RawForgeItem[] = []

  if (repo.forgeType === 'github') {
    const [issues, prs] = await Promise.all([
      listGitHubAiIssues(token, projectRef),
      listGitHubAiPullRequests(token, projectRef),
    ])
    for (const issue of issues) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(issue.labels, 'issue')
      items.push({
        kind: 'issue',
        taskType: resolveTaskType('github', 'issue', taskTypeHint),
        phase,
        phaseLabel,
        externalId: issue.externalId,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        sourceBranch: null,
        createdAt: issue.createdAt,
      })
    }
    for (const pr of prs) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(pr.labels, 'pull_request')
      items.push({
        kind: 'pull_request',
        taskType: resolveTaskType('github', 'pull_request', taskTypeHint),
        phase,
        phaseLabel,
        externalId: pr.externalId,
        title: pr.title,
        url: pr.url,
        labels: pr.labels,
        sourceBranch: pr.sourceBranch || null,
        createdAt: pr.createdAt,
      })
    }
  } else {
    const instanceUrl = repo.instanceUrl || connection.instanceUrl
    const [issues, mrs] = await Promise.all([
      listGitLabAiIssues(instanceUrl, token, projectRef),
      listGitLabAiMergeRequests(instanceUrl, token, projectRef),
    ])
    for (const issue of issues) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(issue.labels, 'issue')
      items.push({
        kind: 'issue',
        taskType: resolveTaskType('gitlab', 'issue', taskTypeHint),
        phase,
        phaseLabel,
        externalId: issue.externalId,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        sourceBranch: null,
        createdAt: issue.createdAt,
      })
    }
    for (const mr of mrs) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(mr.labels, 'merge_request')
      items.push({
        kind: 'merge_request',
        taskType: resolveTaskType('gitlab', 'merge_request', taskTypeHint),
        phase,
        phaseLabel,
        externalId: mr.externalId,
        title: mr.title,
        url: mr.url,
        labels: mr.labels,
        sourceBranch: mr.sourceBranch || null,
        createdAt: mr.createdAt,
      })
    }
  }

  return items
}

async function persistRepoQueueItems(
  repo: typeof repositories.$inferSelect,
  forgeItems: RawForgeItem[],
): Promise<void> {
  const db = getDb()
  const now = new Date()
  const keepKeys = new Set(forgeItems.map((i) => `${i.kind}:${i.externalId}`))

  for (const item of forgeItems) {
    await db.insert(taskQueueItems).values({
      repositoryId: repo.id,
      kind: item.kind,
      taskType: item.taskType,
      phase: item.phase,
      externalId: item.externalId,
      title: item.title,
      url: item.url,
      labels: item.labels,
      sourceBranch: item.sourceBranch,
      forgeCreatedAt: item.createdAt ? new Date(item.createdAt) : null,
      syncedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [taskQueueItems.repositoryId, taskQueueItems.kind, taskQueueItems.externalId],
      set: {
        taskType: item.taskType,
        phase: item.phase,
        title: item.title,
        url: item.url,
        labels: item.labels,
        sourceBranch: item.sourceBranch,
        forgeCreatedAt: item.createdAt ? new Date(item.createdAt) : null,
        syncedAt: now,
        updatedAt: now,
      },
    })
  }

  const existing = await db.select({
    id: taskQueueItems.id,
    kind: taskQueueItems.kind,
    externalId: taskQueueItems.externalId,
  }).from(taskQueueItems).where(eq(taskQueueItems.repositoryId, repo.id))

  const staleIds = existing
    .filter((row) => !keepKeys.has(`${row.kind}:${row.externalId}`))
    .map((row) => row.id)

  if (staleIds.length) {
    await db.delete(taskQueueItems).where(inArray(taskQueueItems.id, staleIds))
  }

  await db.insert(taskQueueRepoSync).values({
    repositoryId: repo.id,
    lastSyncedAt: now,
    lastError: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: taskQueueRepoSync.repositoryId,
    set: {
      lastSyncedAt: now,
      lastError: null,
      updatedAt: now,
    },
  })
}

async function markRepoSyncError(repositoryId: string, message: string): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db.insert(taskQueueRepoSync).values({
    repositoryId,
    lastSyncedAt: null,
    lastError: message,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: taskQueueRepoSync.repositoryId,
    set: {
      lastError: message,
      updatedAt: now,
    },
  })
}

export async function syncRepositoryQueue(
  repo: typeof repositories.$inferSelect,
): Promise<{ ok: boolean, itemCount: number, error?: string }> {
  try {
    const forgeItems = await fetchRepoForgeItems(repo)
    await persistRepoQueueItems(repo, forgeItems)
    return { ok: true, itemCount: forgeItems.length }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err))
    await markRepoSyncError(repo.id, message)
    return { ok: false, itemCount: 0, error: message }
  }
}

export async function syncTaskQueueFromForges(opts?: {
  repositoryIds?: string[]
  reason?: string
}): Promise<{
  repositories: number
  ok: number
  failed: number
  itemCount: number
  errors: Array<{ repositoryId: string, repositoryName: string, message: string }>
}> {
  const db = getDb()
  const conditions = [
    eq(repositories.isEnabled, true),
    eq(repositories.isArchived, false),
  ]
  if (opts?.repositoryIds?.length) {
    conditions.push(inArray(repositories.id, opts.repositoryIds))
  }

  const repos = await db.select().from(repositories).where(and(...conditions))
  const errors: Array<{ repositoryId: string, repositoryName: string, message: string }> = []
  let ok = 0
  let itemCount = 0

  const concurrency = 4
  for (let i = 0; i < repos.length; i += concurrency) {
    const chunk = repos.slice(i, i + concurrency)
    const results = await Promise.all(chunk.map((repo) => syncRepositoryQueue(repo)))
    for (let j = 0; j < results.length; j++) {
      const repo = chunk[j]
      const result = results[j]
      if (result.ok) {
        ok++
        itemCount += result.itemCount
      } else {
        errors.push({
          repositoryId: repo.id,
          repositoryName: repo.name,
          message: result.error || 'sync failed',
        })
      }
    }
  }

  publishQueueUpdated(opts?.reason || 'forge_sync')

  return {
    repositories: repos.length,
    ok,
    failed: errors.length,
    itemCount,
    errors,
  }
}

export async function syncQueueForRepositoryFullName(
  connectionId: string,
  repositoryFullName: string | null | undefined,
  reason = 'webhook',
): Promise<void> {
  if (!repositoryFullName) return
  const db = getDb()
  const normalized = repositoryFullName.replace(/\.git$/, '').toLowerCase()
  const repos = await db.select().from(repositories).where(and(
    eq(repositories.connectionId, connectionId),
    eq(repositories.isEnabled, true),
    eq(repositories.isArchived, false),
  ))
  const match = repos.find((repo) => {
    const candidates = [
      repo.canonicalProjectIdentifier,
      repo.name,
      repo.remoteUrl
        ?.replace(/\.git$/, '')
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^git@[^:]+:/, ''),
    ].filter(Boolean).map((s) => String(s).toLowerCase())
    return candidates.includes(normalized)
  })
  if (!match) return
  await syncRepositoryQueue(match)
  publishQueueUpdated(reason)
}

function buildQueuePayload(
  repos: Array<typeof repositories.$inferSelect>,
  rows: Array<typeof taskQueueItems.$inferSelect>,
  syncRows: Array<typeof taskQueueRepoSync.$inferSelect>,
  runningRuns: Array<typeof taskRuns.$inferSelect>,
  worker: Awaited<ReturnType<typeof getWorkerStatus>>,
) {
  const syncByRepo = new Map(syncRows.map((s) => [s.repositoryId, s]))
  const repoById = new Map(repos.map((r) => [r.id, r]))

  const items: QueueItem[] = rows.map((row) => {
    const repo = repoById.get(row.repositoryId)
    const kind = row.kind as QueueKind
    const phase = row.phase as QueuePhase
    return {
      id: queueItemPublicId(
        (repo?.forgeType || 'github') as 'github' | 'gitlab',
        kind,
        row.repositoryId,
        row.externalId,
      ),
      repositoryId: row.repositoryId,
      repositoryName: repo?.name || 'unknown',
      forgeType: (repo?.forgeType || 'github') as 'github' | 'gitlab',
      kind,
      taskType: row.taskType as QueueTaskType,
      phase,
      phaseLabel: phaseLabelFor(phase, kind),
      statusReason: null,
      externalId: row.externalId,
      title: row.title,
      url: row.url,
      labels: row.labels || [],
      sourceBranch: row.sourceBranch || null,
      branch: row.sourceBranch || null,
      createdAt: (row.forgeCreatedAt || row.createdAt).toISOString(),
      assignedWorker: null,
      isNext: false,
    }
  })

  for (const item of items) {
    item.assignedWorker = pickAssignedWorker(
      item,
      worker.activeTasks || [],
      runningRuns,
      worker.hostname,
    )
    item.branch = resolveItemBranch(item, items)
  }

  const blockOnOpenPrByRepo = new Map(repos.map((r) => [r.id, r.blockOnOpenPr]))
  const nextTask = computeNextTask(items, blockOnOpenPrByRepo)
  if (nextTask) {
    const match = items.find((i) => i.id === nextTask.id)
    if (match) match.isNext = true
  }

  const repoBlockReasonById = new Map(
    repos.map((r) => [r.id, computeRepoBlockReason(r, items)]),
  )
  for (const item of items) {
    item.statusReason = computeStatusReason(
      item,
      items,
      worker.status,
      repoBlockReasonById,
    )
  }

  items.sort((a, b) => {
    const nameCmp = a.repositoryName.localeCompare(b.repositoryName)
    if (nameCmp !== 0) return nameCmp
    const phaseOrder: Record<QueuePhase, number> = {
      working: 0,
      reviewing: 1,
      queued: 2,
      review_queued: 3,
      failed: 4,
      completed: 5,
    }
    const po = phaseOrder[a.phase] - phaseOrder[b.phase]
    if (po !== 0) return po
    return a.createdAt.localeCompare(b.createdAt)
  })

  const itemsByRepo = new Map<string, QueueItem[]>()
  for (const item of items) {
    const list = itemsByRepo.get(item.repositoryId) || []
    list.push(item)
    itemsByRepo.set(item.repositoryId, list)
  }

  const byRepository: RepositoryQueueSummary[] = repos
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((repo) => {
      const repoItems = itemsByRepo.get(repo.id) || []
      const sync = syncByRepo.get(repo.id)
      return {
        repositoryId: repo.id,
        repositoryName: repo.name,
        forgeType: repo.forgeType,
        blockOnOpenPr: repo.blockOnOpenPr,
        itemCount: repoItems.length,
        busy: repoItems.some((i) => i.phase === 'working' || i.phase === 'reviewing' || i.assignedWorker),
        blockReason: repoBlockReasonById.get(repo.id) || null,
        error: sync?.lastError || null,
        lastSyncedAt: sync?.lastSyncedAt?.toISOString() ?? null,
        items: repoItems,
      }
    })

  const errors = byRepository
    .filter((r) => r.error)
    .map((r) => ({
      repositoryId: r.repositoryId,
      repositoryName: r.repositoryName,
      message: r.error as string,
    }))

  const syncedAtCandidates = syncRows
    .map((s) => s.lastSyncedAt?.getTime() ?? 0)
    .filter((t) => t > 0)
  const syncedAt = syncedAtCandidates.length
    ? new Date(Math.max(...syncedAtCandidates)).toISOString()
    : null

  return {
    worker,
    nextTask: nextTask ? items.find((i) => i.id === nextTask.id) || nextTask : null,
    items,
    byRepository,
    errors,
    source: 'database' as const,
    syncedAt,
  }
}

/** Fast path: assemble queue from PostgreSQL (no forge I/O). */
export async function getTaskQueue() {
  const db = getDb()
  const [repos, runningRuns, worker] = await Promise.all([
    db.select().from(repositories).where(and(
      eq(repositories.isEnabled, true),
      eq(repositories.isArchived, false),
    )),
    db.select().from(taskRuns).where(inArray(taskRuns.status, ['running', 'starting'])),
    getWorkerStatus(),
  ])

  if (!repos.length) {
    return {
      worker,
      nextTask: null,
      items: [] as QueueItem[],
      byRepository: [] as RepositoryQueueSummary[],
      errors: [] as Array<{ repositoryId: string, repositoryName: string, message: string }>,
      source: 'database' as const,
      syncedAt: null as string | null,
    }
  }

  const repoIds = repos.map((r) => r.id)
  const [rows, syncRows] = await Promise.all([
    db.select().from(taskQueueItems).where(inArray(taskQueueItems.repositoryId, repoIds)),
    db.select().from(taskQueueRepoSync).where(inArray(taskQueueRepoSync.repositoryId, repoIds)),
  ])

  return buildQueuePayload(repos, rows, syncRows, runningRuns, worker)
}

/**
 * Back-compat entry used by the API.
 * Default = DB. Pass refresh=true to sync forges first (slow).
 */
export async function getLiveTaskQueue(opts?: { refresh?: boolean }) {
  if (opts?.refresh) {
    await syncTaskQueueFromForges({ reason: 'manual_refresh' })
  }
  return getTaskQueue()
}

/** Used by heartbeat / run ingest to refresh assignment without forge I/O. */
export function notifyQueueChanged(reason: string) {
  publishQueueUpdated(reason)
}
