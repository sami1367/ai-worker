import { and, eq, inArray } from 'drizzle-orm'
import { repositories, taskRuns } from '#db/schema'
import { getDb } from '#utils/db'
import { redactSecrets } from '#utils/redact'
import { getConnectionAccessToken } from './connections'
import { listGitHubAiIssues, listGitHubAiPullRequests } from './forge-github'
import { listGitLabAiIssues, listGitLabAiMergeRequests } from './forge-gitlab'
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
  externalId: string
  title: string
  url: string
  labels: string[]
  createdAt: string
  assignedWorker: AssignedWorker | null
  isNext: boolean
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

function classifyPhase(labels: string[], kind: QueueKind): { phase: QueuePhase, phaseLabel: string, taskTypeHint: 'implement' | 'review' } {
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
  if (set.has('ai-pr')) {
    return { phase: 'completed', phaseLabel: 'AI PR created', taskTypeHint: 'implement' }
  }
  if (set.has('ai')) {
    return { phase: 'queued', phaseLabel: 'Queued for AI', taskTypeHint: 'implement' }
  }

  return { phase: 'queued', phaseLabel: 'Queued', taskTypeHint: kind === 'issue' ? 'implement' : 'review' }
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
      startedAt: fromHeartbeat.startedAt ?? null,
    }
  }

  const run = runningRuns.find((r) =>
    r.externalId === item.externalId
    && r.forgeType === item.forgeType
    && (r.repositoryId === item.repositoryId || !r.repositoryId),
  )
  if (run) {
    return {
      source: 'task_run',
      hostname: workerHost,
      pid: null,
      repositoryName: item.repositoryName,
      taskType: run.taskType,
      externalId: run.externalId,
      startedAt: run.startedAt?.toISOString() ?? null,
      runId: run.id,
    }
  }

  return null
}

function computeNextTask(items: QueueItem[]): QueueItem | null {
  const busyRepos = new Set(
    items
      .filter((i) => i.phase === 'working' || i.phase === 'reviewing' || i.assignedWorker)
      .map((i) => i.repositoryId),
  )

  const eligible = items
    .filter((i) =>
      (i.phase === 'queued' || i.phase === 'review_queued')
      && !busyRepos.has(i.repositoryId)
      && !i.assignedWorker,
    )
    .sort((a, b) => {
      const p = taskTypePriority(a.taskType) - taskTypePriority(b.taskType)
      if (p !== 0) return p
      return a.createdAt.localeCompare(b.createdAt)
    })

  return eligible[0] ?? null
}

async function fetchRepoQueueItems(
  repo: typeof repositories.$inferSelect,
): Promise<QueueItem[]> {
  if (!repo.connectionId) {
    throw new Error('Repository is not linked to a forge connection')
  }
  const projectRef = resolveProjectRef(repo)
  if (!projectRef) {
    throw new Error('Repository has no project identifier')
  }

  const { token, row: connection } = await getConnectionAccessToken(repo.connectionId)
  const items: QueueItem[] = []

  if (repo.forgeType === 'github') {
    const [issues, prs] = await Promise.all([
      listGitHubAiIssues(token, projectRef),
      listGitHubAiPullRequests(token, projectRef),
    ])
    for (const issue of issues) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(issue.labels, 'issue')
      const taskType = resolveTaskType('github', 'issue', taskTypeHint)
      items.push({
        id: `github:issue:${repo.id}:${issue.externalId}`,
        repositoryId: repo.id,
        repositoryName: repo.name,
        forgeType: 'github',
        kind: 'issue',
        taskType,
        phase,
        phaseLabel,
        externalId: issue.externalId,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        createdAt: issue.createdAt,
        assignedWorker: null,
        isNext: false,
      })
    }
    for (const pr of prs) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(pr.labels, 'pull_request')
      const taskType = resolveTaskType('github', 'pull_request', taskTypeHint)
      items.push({
        id: `github:pr:${repo.id}:${pr.externalId}`,
        repositoryId: repo.id,
        repositoryName: repo.name,
        forgeType: 'github',
        kind: 'pull_request',
        taskType,
        phase,
        phaseLabel,
        externalId: pr.externalId,
        title: pr.title,
        url: pr.url,
        labels: pr.labels,
        createdAt: pr.createdAt,
        assignedWorker: null,
        isNext: false,
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
      const taskType = resolveTaskType('gitlab', 'issue', taskTypeHint)
      items.push({
        id: `gitlab:issue:${repo.id}:${issue.externalId}`,
        repositoryId: repo.id,
        repositoryName: repo.name,
        forgeType: 'gitlab',
        kind: 'issue',
        taskType,
        phase,
        phaseLabel,
        externalId: issue.externalId,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        createdAt: issue.createdAt,
        assignedWorker: null,
        isNext: false,
      })
    }
    for (const mr of mrs) {
      const { phase, phaseLabel, taskTypeHint } = classifyPhase(mr.labels, 'merge_request')
      const taskType = resolveTaskType('gitlab', 'merge_request', taskTypeHint)
      items.push({
        id: `gitlab:mr:${repo.id}:${mr.externalId}`,
        repositoryId: repo.id,
        repositoryName: repo.name,
        forgeType: 'gitlab',
        kind: 'merge_request',
        taskType,
        phase,
        phaseLabel,
        externalId: mr.externalId,
        title: mr.title,
        url: mr.url,
        labels: mr.labels,
        createdAt: mr.createdAt,
        assignedWorker: null,
        isNext: false,
      })
    }
  }

  return items
}

export async function getLiveTaskQueue() {
  const db = getDb()
  const [repos, runningRuns, worker] = await Promise.all([
    db.select().from(repositories).where(and(
      eq(repositories.isEnabled, true),
      eq(repositories.isArchived, false),
    )),
    db.select().from(taskRuns).where(inArray(taskRuns.status, ['running', 'starting'])),
    getWorkerStatus(),
  ])

  const items: QueueItem[] = []
  const errors: Array<{ repositoryId: string, repositoryName: string, message: string }> = []

  // Bound concurrency so many repos don't stampede forge APIs
  const concurrency = 4
  for (let i = 0; i < repos.length; i += concurrency) {
    const chunk = repos.slice(i, i + concurrency)
    const results = await Promise.allSettled(chunk.map((repo) => fetchRepoQueueItems(repo)))
    for (let j = 0; j < results.length; j++) {
      const repo = chunk[j]
      const result = results[j]
      if (result.status === 'fulfilled') {
        items.push(...result.value)
      } else {
        errors.push({
          repositoryId: repo.id,
          repositoryName: repo.name,
          message: redactSecrets(result.reason instanceof Error ? result.reason.message : String(result.reason)),
        })
      }
    }
  }

  for (const item of items) {
    item.assignedWorker = pickAssignedWorker(
      item,
      worker.activeTasks || [],
      runningRuns,
      worker.hostname,
    )
  }

  const nextTask = computeNextTask(items)
  if (nextTask) {
    const match = items.find((i) => i.id === nextTask.id)
    if (match) match.isNext = true
  }

  items.sort((a, b) => {
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

  return {
    worker,
    nextTask: nextTask ? items.find((i) => i.id === nextTask.id) || nextTask : null,
    items,
    errors,
  }
}
