import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm'
import { microserviceGroups, repositories } from '#db/schema'
import { getDb } from '#utils/db'
import { AppError } from '#utils/errors'
import { redactSecrets } from '#utils/redact'
import { microserviceGroupSchema, type MicroserviceGroupInput } from '#shared/microservices'
import { ensurePlanningWorkspace } from './task-planning'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { queueWorkspaceOperation } from './workspace-manager'
import { indexMicroserviceWorkspace, microserviceWorkspacePath, projectDirectories, syncMicroserviceClone, writeMicroserviceManifest } from './microservice-workspace'

type Actor = { id: string, username: string }
export async function ownedMicroserviceGroup(id: string, userId: string) {
  const [group] = await getDb().select().from(microserviceGroups).where(and(
    eq(microserviceGroups.id, id), eq(microserviceGroups.createdByUserId, userId),
  )).limit(1)
  if (!group) throw new AppError(404, 'Microservice group not found', 'not_found')
  return group
}
export async function microserviceRepositories(group: Pick<typeof microserviceGroups.$inferSelect, 'projects'>) {
  const rows = await getDb().select().from(repositories).where(inArray(repositories.id, group.projects.map(project => project.repositoryId)))
  return group.projects.map(project => {
    const repo = rows.find(row => row.id === project.repositoryId && !row.isArchived)
    if (!repo) throw new AppError(409, 'A project in this group was archived or removed. Edit the group to choose available projects.', 'missing_repository')
    return { ...project, repository: repo }
  })
}
export async function listMicroserviceGroups(userId: string) {
  return { items: await getDb().select().from(microserviceGroups).where(eq(microserviceGroups.createdByUserId, userId)).orderBy(desc(microserviceGroups.updatedAt)) }
}
export async function getMicroserviceGroup(id: string, userId: string) {
  const group = await ownedMicroserviceGroup(id, userId)
  const rows = await getDb().select().from(repositories).where(inArray(repositories.id, group.projects.map(project => project.repositoryId)))
  return { group, workspacePath: microserviceWorkspacePath(group.id), projects: group.projects.map(project => {
    const repo = rows.find(row => row.id === project.repositoryId)
    return { ...project, name: repo?.name || 'Removed project', workspaceStatus: !repo || repo.isArchived ? 'unavailable' : repo.workspaceStatus }
  }) }
}
export async function saveMicroserviceGroup(input: MicroserviceGroupInput, actor: Actor, id?: string) {
  const parsed = microserviceGroupSchema.safeParse(input)
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message || 'Invalid group', 'validation_error')
  const data = parsed.data
  const old = id ? await ownedMicroserviceGroup(id, actor.id) : null
  const rows = await getDb().select().from(repositories).where(inArray(repositories.id, data.projects.map(project => project.repositoryId)))
  if (rows.length !== data.projects.length || rows.some(row => row.isArchived)) throw new AppError(400, 'Choose available repositories', 'validation_error')
  if (old?.workspaceStatus === 'preparing') throw new AppError(409, 'Wait for workspace preparation to finish before editing', 'workspace_busy')
  const directories = projectDirectories(data.projects.map(project => ({ repositoryId: project.repositoryId, name: rows.find(row => row.id === project.repositoryId)!.name })))
  const values = {
    name: data.name, description: data.description, codegraphEnabled: data.codegraphEnabled,
    projects: data.projects.map((project, index) => ({ ...project, labels: [...new Set(project.labels)], directory: directories[index]! })),
    workspaceStatus: 'queued', codegraphStatus: 'pending', lastError: null, updatedAt: new Date(),
  }
  const [group] = old
    ? await getDb().update(microserviceGroups).set(values).where(and(eq(microserviceGroups.id, old.id), eq(microserviceGroups.createdByUserId, actor.id), eq(microserviceGroups.updatedAt, old.updatedAt))).returning()
    : await getDb().insert(microserviceGroups).values({ ...values, createdByUserId: actor.id }).returning()
  if (!group) throw new AppError(409, 'Group changed. Reload and try again.', 'group_conflict')
  startMicroserviceWorkspaceWorker()
  void processMicroserviceWorkspaces()
  return { group }
}
export async function queueMicroservicePreparation(id: string, actor: Actor) {
  const group = await ownedMicroserviceGroup(id, actor.id)
  if (['preparing', 'queued', 'waiting'].includes(group.workspaceStatus)) return { group }
  const [claimed] = await getDb().update(microserviceGroups).set({ workspaceStatus: 'preparing', lastError: null, updatedAt: new Date() })
    .where(and(eq(microserviceGroups.id, id), eq(microserviceGroups.updatedAt, group.updatedAt))).returning()
  if (!claimed) throw new AppError(409, 'Group changed. Reload and try again.', 'group_conflict')
  try {
    // Refresh sources through the existing authenticated queue before rebuilding group clones.
    const projects = await microserviceRepositories(group)
    for (const project of projects) {
      await queueWorkspaceOperation({ repositoryId: project.repositoryId,
        operationType: project.repository.workspaceStatus === 'ready' ? 'sync' : 'clone', actor })
    }
    const [updated] = await getDb().update(microserviceGroups).set({ workspaceStatus: 'waiting', codegraphStatus: 'pending', updatedAt: new Date() })
      .where(eq(microserviceGroups.id, id)).returning()
    startMicroserviceWorkspaceWorker()
    void processMicroserviceWorkspaces()
    return { group: updated! }
  } catch (error) {
    await getDb().update(microserviceGroups).set({ workspaceStatus: 'failed', lastError: 'Could not queue repository refresh. Check group projects and retry.', updatedAt: new Date() })
      .where(eq(microserviceGroups.id, id))
    throw error
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let processing = false
export function startMicroserviceWorkspaceWorker() {
  if (timer) return
  timer = setInterval(() => { void processMicroserviceWorkspaces() }, 5000)
  timer.unref?.()
}
export async function processMicroserviceWorkspaces() {
  if (processing) return
  processing = true
  try {
    const rows = await getDb().select().from(microserviceGroups).where(or(
      inArray(microserviceGroups.workspaceStatus, ['queued', 'waiting']),
      and(eq(microserviceGroups.workspaceStatus, 'preparing'), lt(microserviceGroups.updatedAt, new Date(Date.now() - 20 * 60_000))),
    )).orderBy(asc(microserviceGroups.updatedAt)).limit(10)
    for (const row of rows) await prepareGroup(row)
  } catch (error) {
    console.warn('[microservices] Workspace queue:', redactSecrets(error instanceof Error ? error.message : 'Preparation failed'))
  } finally { processing = false }
}
async function prepareGroup(group: typeof microserviceGroups.$inferSelect) {
  const db = getDb()
  const [claimed] = await db.update(microserviceGroups).set({ workspaceStatus: 'preparing', updatedAt: new Date() })
    .where(and(eq(microserviceGroups.id, group.id), eq(microserviceGroups.updatedAt, group.updatedAt))).returning()
  if (!claimed) return
  const update = async (values: Partial<typeof microserviceGroups.$inferInsert>) => {
    await db.update(microserviceGroups).set({ ...values, updatedAt: new Date() }).where(eq(microserviceGroups.id, group.id))
  }
  try {
    const projects = await microserviceRepositories(group)
    const failed = projects.filter(project => ['failed', 'inaccessible'].includes(project.repository.workspaceStatus))
    // Queue/retry failed sources once per explicit preparation, rather than looping forever.
    if (failed.length && group.workspaceStatus === 'waiting') throw new Error(`Repository clone failed: ${failed.map(project => project.repository.name).join(', ')}. Repair the connection and retry preparation.`)
    let waiting = false
    for (const project of projects) {
      const actor = { id: group.createdByUserId, username: 'microservices' }
      const repo = project.repository
      if (repo.workspaceStatus !== 'ready') {
        await ensurePlanningWorkspace(repo, actor)
        waiting = true
      } else {
        try {
          if (!repo.localPath) throw new Error('Missing source')
          await access(join(repo.localPath, '.git'))
        } catch {
          await queueWorkspaceOperation({ repositoryId: repo.id, operationType: 'clone', actor })
          waiting = true
        }
      }
    }
    if (waiting) {
      await update({ workspaceStatus: 'waiting', lastError: null })
      return
    }
    const root = microserviceWorkspacePath(group.id)
    const prepared = []
    for (const project of projects) {
      const repo = project.repository
      const commit = await syncMicroserviceClone(root, project.directory, repo.localPath!, repo.defaultBranch)
      prepared.push({ repositoryId: repo.id, name: repo.name, directory: project.directory, labels: project.labels, description: project.description, commit })
      await update({ workspaceStatus: 'preparing' })
    }
    await writeMicroserviceManifest(root, group.name, group.description, prepared)
    let codegraphStatus = 'disabled'
    let warning: string | null = null
    try { codegraphStatus = await indexMicroserviceWorkspace(root, group.codegraphEnabled) } catch {
      codegraphStatus = 'unavailable'
      warning = 'CodeGraph could not index this group. Chat will use repository snapshots. Retry preparation to rebuild the index.'
    }
    await update({ workspaceStatus: 'ready', codegraphStatus, lastError: warning, preparedAt: new Date() })
  } catch (error) {
    await update({ workspaceStatus: 'failed', lastError: redactSecrets(error instanceof Error ? error.message : 'Workspace preparation failed').slice(0, 1000) })
  }
}
