import { randomUUID } from 'node:crypto'
import { and, desc, eq, ne } from 'drizzle-orm'
import {
  repositories,
  taskPlanningSessions,
  type TaskPlanningCreatedIssue,
  type TaskPlanningMessage,
} from '#db/schema'
import { getDb } from '#utils/db'
import { AppError } from '#utils/errors'
import { writeAudit } from './audit'
import { ensureConnectionAccount } from './connections'
import { ensureRepositoryLabels } from './ai-labels'
import { createGitHubIssue } from './forge-github'
import { createGitLabIssue } from './forge-gitlab'
import { buildRepoCodeContext } from './task-planning-context'
import {
  callPlanningLlm,
  planningProviderForRepo,
  type PlanningLlmMessage,
} from './task-planning-llm'
import {
  extractJsonObject,
  formatTasksForChat,
  normalizeDraftTasks,
  parsePlanningStatusLine,
  stripPlanningStatusLine,
} from './task-planning-parse'

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

function publicSession(row: typeof taskPlanningSessions.$inferSelect) {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    createdByUserId: row.createdByUserId,
    status: row.status,
    epicSummary: row.epicSummary,
    messages: row.messages || [],
    draftTasks: row.draftTasks || [],
    createdIssues: row.createdIssues || [],
    providerType: row.providerType,
    codeContextAvailable: Boolean(row.codeContextSummary && !row.codeContextSummary.includes('not cloned')),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const SYSTEM_CHAT = `You are a senior technical product partner helping a non-technical product manager break an epic into implementable engineering tasks for an AI coding worker.

Rules:
- Ask clear, short clarifying questions when scope, users, acceptance criteria, platforms, or constraints are unclear.
- Prefer 1–4 questions at a time, not a long questionnaire.
- When you have enough detail to draft tasks, say so explicitly and invite the user to press "Generate tasks".
- Do NOT invent a full task list until asked to generate (the UI has a Generate button). You may sketch themes verbally.
- Ground answers in the provided live repository code context when present (file tree, manifests, CodeGraph). If context is missing, say so and avoid guessing file paths.
- Write for a PM: plain language, no jargon unless explained.
- Never claim you already created GitHub/GitLab issues; creation happens only after Approve.

Response style: conversational markdown. End with a short "Status:" line that is exactly one of:
Status: need_clarification
Status: ready_to_generate
Status: refining_draft`

const SYSTEM_GENERATE = `You break an epic into concrete GitHub/GitLab issues for an AI coding agent.

Return ONLY valid JSON (no markdown fences) with this shape:
{
  "epicSummary": "one paragraph",
  "assistantMessage": "short message to the PM summarizing the task plan",
  "tasks": [
    {
      "title": "short imperative title",
      "body": "markdown issue body with Goal, Context, Acceptance criteria, and Out of scope"
    }
  ]
}

Rules:
- 3–12 tasks unless the epic is tiny (min 1) or huge (cap 25).
- Each task must be independently implementable by an AI agent in one PR when possible.
- Reference real paths/modules from the code context when known.
- Titles ≤ 90 characters.
- Bodies must include Acceptance criteria as a checklist.
- Do not include labels or assignees in the JSON (the platform adds the "ai" label and assignee).`

async function loadRepo(repositoryId: string) {
  const db = getDb()
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1)
  if (!repo || repo.isArchived) throw new AppError(404, 'Repository not found', 'not_found')
  return repo
}

async function refreshCodeContext(
  sessionId: string,
  repo: typeof repositories.$inferSelect,
  epicHint?: string,
) {
  const ctx = await buildRepoCodeContext({
    localPath: repo.localPath,
    workspaceStatus: repo.workspaceStatus,
    epicHint,
  })
  const db = getDb()
  await db.update(taskPlanningSessions).set({
    codeContextSummary: ctx.summary,
    updatedAt: new Date(),
  }).where(eq(taskPlanningSessions.id, sessionId))
  return ctx
}

export async function listPlanningSessions(repositoryId?: string) {
  const db = getDb()
  const rows = repositoryId
    ? await db.select().from(taskPlanningSessions)
      .where(eq(taskPlanningSessions.repositoryId, repositoryId))
      .orderBy(desc(taskPlanningSessions.updatedAt))
      .limit(50)
    : await db.select().from(taskPlanningSessions)
      .orderBy(desc(taskPlanningSessions.updatedAt))
      .limit(50)
  return { items: rows.map(publicSession) }
}

export async function getPlanningSession(id: string) {
  const db = getDb()
  const [row] = await db.select().from(taskPlanningSessions)
    .where(eq(taskPlanningSessions.id, id)).limit(1)
  if (!row) throw new AppError(404, 'Planning session not found', 'not_found')
  const repo = await loadRepo(row.repositoryId)
  return {
    session: publicSession(row),
    repository: {
      id: repo.id,
      name: repo.name,
      forgeType: repo.forgeType,
      canonicalProjectIdentifier: repo.canonicalProjectIdentifier,
      workspaceStatus: repo.workspaceStatus,
      defaultAiProvider: repo.defaultAiProvider,
      connectionId: repo.connectionId,
    },
  }
}

export async function createPlanningSession(
  repositoryId: string,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const repo = await loadRepo(repositoryId)
  if (!repo.connectionId) {
    throw new AppError(
      400,
      'Repository is not linked to a forge connection. Connect GitHub/GitLab and register the repo first.',
      'missing_connection',
    )
  }

  const prefer = await planningProviderForRepo(repo.defaultAiProvider)
  const ctx = await buildRepoCodeContext({
    localPath: repo.localPath,
    workspaceStatus: repo.workspaceStatus,
  })

  const welcome: TaskPlanningMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: [
      `Hi — I will help you turn an epic into AI-ready tasks for **${repo.name}** (${repo.forgeType}).`,
      '',
      ctx.available
        ? 'I loaded a live snapshot of this repository (file tree + key manifests). Describe what you want to build or change.'
        : 'This repository workspace is not ready yet, so I will plan from your description. You can still continue; clone/sync the repo later for more accurate tasks.',
      '',
      'Tell me the goal in plain language. I may ask a few clarifying questions, then you can generate draft tasks, refine them here, and approve to create issues labeled **ai** assigned to your connected forge user.',
      '',
      'Status: need_clarification',
    ].join('\n'),
    createdAt: new Date().toISOString(),
  }

  const db = getDb()
  const [row] = await db.insert(taskPlanningSessions).values({
    repositoryId: repo.id,
    createdByUserId: actor.id,
    status: 'clarifying',
    messages: [welcome],
    draftTasks: [],
    createdIssues: [],
    providerType: prefer,
    codeContextSummary: ctx.summary,
  }).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'task_planning.session_created',
    targetType: 'task_planning_session',
    targetId: row!.id,
    metadata: { repositoryId: repo.id, repositoryName: repo.name },
    ipHash,
  })

  return publicSession(row!)
}

/** Open latest active session for a repo, or create a new one. */
export async function openPlanningSessionForRepo(
  repositoryId: string,
  actor: { id: string, username: string },
  ipHash?: string,
  opts?: { forceNew?: boolean },
) {
  if (!opts?.forceNew) {
    const db = getDb()
    const [existing] = await db.select().from(taskPlanningSessions).where(and(
      eq(taskPlanningSessions.repositoryId, repositoryId),
      ne(taskPlanningSessions.status, 'created'),
    )).orderBy(desc(taskPlanningSessions.updatedAt)).limit(1)
    if (existing) {
      const repo = await loadRepo(repositoryId)
      await refreshCodeContext(existing.id, repo, existing.epicSummary || undefined)
      const [fresh] = await db.select().from(taskPlanningSessions)
        .where(eq(taskPlanningSessions.id, existing.id)).limit(1)
      return publicSession(fresh!)
    }
  }
  return createPlanningSession(repositoryId, actor, ipHash)
}

export async function postPlanningMessage(
  sessionId: string,
  content: string,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const text = content.trim()
  if (!text) throw new AppError(400, 'Message is required', 'validation_error')
  if (text.length > 20_000) throw new AppError(400, 'Message is too long', 'validation_error')

  const db = getDb()
  const [session] = await db.select().from(taskPlanningSessions)
    .where(eq(taskPlanningSessions.id, sessionId)).limit(1)
  if (!session) throw new AppError(404, 'Planning session not found', 'not_found')
  if (session.status === 'created') {
    throw new AppError(400, 'This session already created issues. Start a new session to plan more work.', 'session_closed')
  }

  const repo = await loadRepo(session.repositoryId)
  await refreshCodeContext(sessionId, repo, text)

  const [fresh] = await db.select().from(taskPlanningSessions)
    .where(eq(taskPlanningSessions.id, sessionId)).limit(1)
  const current = fresh!

  const userMsg: TaskPlanningMessage = {
    id: randomUUID(),
    role: 'user',
    content: text,
    createdAt: new Date().toISOString(),
  }

  const history: PlanningLlmMessage[] = [
    {
      role: 'system',
      content: [
        SYSTEM_CHAT,
        '',
        `Repository: ${repo.name} (${repo.forgeType})`,
        `Project: ${resolveProjectRef(repo) || repo.name}`,
        '',
        '## Live code context',
        current.codeContextSummary || '_unavailable_',
        '',
        current.draftTasks?.length
          ? `## Current draft tasks (${current.draftTasks.length})\n${formatTasksForChat(current.draftTasks)}`
          : '## Current draft tasks\n_none yet_',
      ].join('\n'),
    },
    ...current.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-24)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: text },
  ]

  const prefer = await planningProviderForRepo(repo.defaultAiProvider)
  const { text: replyRaw, provider } = await callPlanningLlm({
    messages: history,
    preferProviderType: prefer,
  })

  const status = parsePlanningStatusLine(replyRaw)
  const reply = stripPlanningStatusLine(replyRaw)
  const assistantMsg: TaskPlanningMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: reply,
    createdAt: new Date().toISOString(),
  }

  const nextMessages = [...current.messages, userMsg, assistantMsg]
  const nextStatus = current.draftTasks?.length && status === 'clarifying'
    ? 'draft'
    : status === 'ready_to_generate'
      ? 'ready_to_generate'
      : status === 'draft'
        ? (current.draftTasks?.length ? 'draft' : 'clarifying')
        : status

  const [updated] = await db.update(taskPlanningSessions).set({
    messages: nextMessages,
    status: nextStatus === 'draft' && !(current.draftTasks?.length) ? 'clarifying' : nextStatus,
    providerType: provider.providerType,
    epicSummary: current.epicSummary || text.slice(0, 500),
    updatedAt: new Date(),
  }).where(eq(taskPlanningSessions.id, sessionId)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'task_planning.message',
    targetType: 'task_planning_session',
    targetId: sessionId,
    metadata: { provider: provider.providerType, status: updated!.status },
    ipHash,
  })

  return publicSession(updated!)
}

export async function generatePlanningTasks(
  sessionId: string,
  actor: { id: string, username: string },
  ipHash?: string,
  opts?: { regenerate?: boolean },
) {
  const db = getDb()
  const [session] = await db.select().from(taskPlanningSessions)
    .where(eq(taskPlanningSessions.id, sessionId)).limit(1)
  if (!session) throw new AppError(404, 'Planning session not found', 'not_found')
  if (session.status === 'created') {
    throw new AppError(400, 'This session already created issues. Start a new session.', 'session_closed')
  }

  const repo = await loadRepo(session.repositoryId)
  await refreshCodeContext(sessionId, repo, session.epicSummary || undefined)
  const [current] = await db.select().from(taskPlanningSessions)
    .where(eq(taskPlanningSessions.id, sessionId)).limit(1)
  if (!current) throw new AppError(404, 'Planning session not found', 'not_found')

  const conversation = current.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')

  const regenerateNote = opts?.regenerate && current.draftTasks?.length
    ? `\n\nPrevious draft tasks (revise based on the conversation):\n${formatTasksForChat(current.draftTasks)}`
    : ''

  const prefer = await planningProviderForRepo(repo.defaultAiProvider)
  const { text: raw, provider } = await callPlanningLlm({
    preferProviderType: prefer,
    messages: [
      { role: 'system', content: SYSTEM_GENERATE },
      {
        role: 'user',
        content: [
          `Repository: ${repo.name} (${repo.forgeType})`,
          `Project: ${resolveProjectRef(repo) || repo.name}`,
          '',
          '## Live code context',
          current.codeContextSummary || '_unavailable_',
          '',
          '## Conversation',
          conversation || '_empty_',
          regenerateNote,
          '',
          'Produce the JSON task plan now.',
        ].join('\n'),
      },
    ],
  })

  let parsed: unknown
  try {
    parsed = extractJsonObject(raw)
  } catch {
    throw new AppError(502, 'Model did not return valid task JSON. Try Generate again.', 'planning_parse_error')
  }

  const tasks = normalizeDraftTasks(parsed)
  if (!tasks.length) {
    throw new AppError(502, 'Model returned no tasks. Add more detail in chat, then generate again.', 'planning_empty_tasks')
  }

  const epicSummary = String((parsed as { epicSummary?: unknown }).epicSummary || current.epicSummary || '').trim()
    || tasks[0]!.title
  const assistantText = String((parsed as { assistantMessage?: unknown }).assistantMessage || '').trim()
    || (opts?.regenerate ? 'Here is a regenerated task plan.' : 'Here is a draft task plan for your epic.')

  const assistantMsg: TaskPlanningMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: `${assistantText}\n\n${formatTasksForChat(tasks)}\n\nReview the tasks above. Reply in chat to change specific ones, or use **Regenerate** / **Approve & create**.`,
    createdAt: new Date().toISOString(),
    tasks,
  }

  const [updated] = await db.update(taskPlanningSessions).set({
    status: 'draft',
    epicSummary: epicSummary.slice(0, 4000),
    draftTasks: tasks,
    messages: [...current.messages, assistantMsg],
    providerType: provider.providerType,
    updatedAt: new Date(),
  }).where(eq(taskPlanningSessions.id, sessionId)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: opts?.regenerate ? 'task_planning.regenerate' : 'task_planning.generate',
    targetType: 'task_planning_session',
    targetId: sessionId,
    metadata: { taskCount: tasks.length, provider: provider.providerType },
    ipHash,
  })

  return publicSession(updated!)
}

export async function approvePlanningTasks(
  sessionId: string,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const db = getDb()
  const [session] = await db.select().from(taskPlanningSessions)
    .where(eq(taskPlanningSessions.id, sessionId)).limit(1)
  if (!session) throw new AppError(404, 'Planning session not found', 'not_found')
  if (session.status === 'created') {
    return publicSession(session)
  }
  if (!session.draftTasks?.length) {
    throw new AppError(400, 'Generate draft tasks before approving', 'no_draft_tasks')
  }

  const repo = await loadRepo(session.repositoryId)
  if (!repo.connectionId) {
    throw new AppError(400, 'Repository is not linked to a forge connection', 'missing_connection')
  }
  const projectRef = resolveProjectRef(repo)
  if (!projectRef) {
    throw new AppError(400, 'Repository has no project identifier', 'missing_project_ref')
  }

  await ensureRepositoryLabels(repo.id, { strict: true })
  const { token, row: connection } = await ensureConnectionAccount(repo.connectionId)
  if (!connection.accountLogin) {
    throw new AppError(400, 'Forge connection has no account login; reconnect the connection', 'missing_account')
  }

  const created: TaskPlanningCreatedIssue[] = []
  const errors: string[] = []

  for (const task of session.draftTasks) {
    const body = [
      task.body,
      '',
      '---',
      `_Created via AI Worker Create Tasks by ${actor.username}. Epic: ${session.epicSummary || 'n/a'}_`,
    ].join('\n')

    try {
      if (repo.forgeType === 'github') {
        const issue = await createGitHubIssue({
          token,
          fullName: projectRef,
          title: task.title,
          body,
          labels: ['ai'],
          assignees: [connection.accountLogin],
        })
        created.push({
          localId: task.localId,
          externalId: issue.externalId,
          title: issue.title,
          url: issue.url,
        })
      } else {
        const assigneeId = connection.accountId ? Number(connection.accountId) : NaN
        const issue = await createGitLabIssue({
          instanceUrl: connection.instanceUrl || repo.instanceUrl || 'https://gitlab.com',
          token,
          projectPath: projectRef,
          title: task.title,
          body,
          labels: ['ai'],
          assigneeIds: Number.isFinite(assigneeId) ? [assigneeId] : undefined,
        })
        created.push({
          localId: task.localId,
          externalId: issue.externalId,
          title: issue.title,
          url: issue.url,
        })
      }
    } catch (err) {
      errors.push(`${task.title}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!created.length) {
    throw new AppError(
      502,
      `Failed to create issues: ${errors.slice(0, 3).join('; ')}`,
      'forge_create_failed',
    )
  }

  const links = created.map((c) => `- [#${c.externalId}](${c.url}) ${c.title}`).join('\n')
  const assistantMsg: TaskPlanningMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: [
      `Approved — created **${created.length}** issue(s) on ${repo.forgeType} with label **ai**, assigned to **${connection.accountLogin}**.`,
      '',
      links,
      errors.length ? `\nSome issues failed:\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
      '',
      'The worker will pick them up when it is running and the repository is enabled.',
    ].filter(Boolean).join('\n'),
    createdAt: new Date().toISOString(),
  }

  const [updated] = await db.update(taskPlanningSessions).set({
    status: 'created',
    createdIssues: created,
    messages: [...session.messages, assistantMsg],
    updatedAt: new Date(),
  }).where(eq(taskPlanningSessions.id, sessionId)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'task_planning.approve',
    targetType: 'task_planning_session',
    targetId: sessionId,
    metadata: {
      createdCount: created.length,
      failedCount: errors.length,
      assignee: connection.accountLogin,
      forgeType: repo.forgeType,
    },
    ipHash,
  })

  return publicSession(updated!)
}
