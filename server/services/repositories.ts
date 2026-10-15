import { and, count, desc, eq, ilike, isNull, notInArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { repositories, taskRuns } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { managedWorkspacePath, newWorkspaceId, validateRemoteUrl } from '#utils/paths'
import { ensureRepositoryLabels } from './ai-labels'
import { writeAudit } from './audit'
import { exportWorkerConfig } from './config-sync'
import { listPausedConnectionIds } from './connections'
import { getSettings } from './settings'

export const bulkSetEnabledSchema = z.object({
  enabled: z.boolean(),
  connectionId: z.string().uuid().optional(),
  forgeType: z.enum(['github', 'gitlab']).optional(),
  q: z.string().max(256).optional(),
  workspaceStatus: z.string().max(64).optional(),
})

export const repositorySettingsSchema = z.object({
  /** Optional instructions appended to every AI prompt for this repository. Default empty. */
  customPrompt: z.string().max(100_000).optional(),
}).passthrough()

export const createRepositorySchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._/-]+$/),
  forgeType: z.enum(['github', 'gitlab']),
  remoteUrl: z.string().min(1).max(1024),
  canonicalProjectIdentifier: z.string().max(256).optional(),
  defaultBranch: z.string().min(1).max(128).default('main'),
  blockOnOpenPr: z.boolean().optional(),
  /** When true, force-push to defaultBranch instead of opening a PR/MR. Default false. */
  forcePushToDefault: z.boolean().optional(),
  defaultAiProvider: z.enum(['cursor', 'claude']).nullable().optional(),
  settings: repositorySettingsSchema.optional(),
  activate: z.boolean().default(false),
  localPath: z.string().max(1024).optional(),
  allowHostPath: z.boolean().default(false),
})

export const updateRepositorySchema = createRepositorySchema.partial().omit({ name: true, forgeType: true })

/** Read the per-repo custom prompt from settings (default empty). */
export function customPromptFromSettings(settings: Record<string, unknown> | null | undefined): string {
  const value = settings?.customPrompt
  return typeof value === 'string' ? value : ''
}

export async function listRepositories(opts: {
  page: number
  pageSize: number
  q?: string
  forgeType?: 'github' | 'gitlab'
  enabled?: boolean
  includeArchived?: boolean
  workspaceStatus?: string
  connectionId?: string
}) {
  const db = getDb()
  const page = Math.max(1, opts.page)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize))
  const offset = (page - 1) * pageSize

  const conditions = []
  if (!opts.includeArchived) conditions.push(eq(repositories.isArchived, false))
  if (opts.forgeType) conditions.push(eq(repositories.forgeType, opts.forgeType))
  if (opts.enabled !== undefined) conditions.push(eq(repositories.isEnabled, opts.enabled))
  if (opts.workspaceStatus) {
    conditions.push(eq(
      repositories.workspaceStatus,
      opts.workspaceStatus as typeof repositories.$inferSelect.workspaceStatus,
    ))
  }
  if (opts.connectionId) conditions.push(eq(repositories.connectionId, opts.connectionId))
  if (opts.q) {
    conditions.push(or(
      ilike(repositories.name, `%${opts.q}%`),
      ilike(repositories.remoteUrl, `%${opts.q}%`),
      ilike(repositories.canonicalProjectIdentifier, `%${opts.q}%`),
    ))
  }

  // Hide repositories belonging to disabled connections on the repositories page.
  const pausedIds = await listPausedConnectionIds()
  if (pausedIds.length) {
    conditions.push(or(
      isNull(repositories.connectionId),
      notInArray(repositories.connectionId, pausedIds),
    ))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const items = await db.select().from(repositories).where(where).orderBy(desc(repositories.updatedAt)).limit(pageSize).offset(offset)
  const [totalRow] = await db.select({ c: count() }).from(repositories).where(where)

  return { items: items.map(publicRepo), page, pageSize, total: totalRow?.c ?? 0 }
}

export function publicRepo(row: typeof repositories.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    forgeType: row.forgeType,
    remoteUrl: row.remoteUrl,
    canonicalProjectIdentifier: row.canonicalProjectIdentifier,
    workspaceId: row.workspaceId,
    localPath: row.localPath,
    defaultBranch: row.defaultBranch,
    isEnabled: row.isEnabled,
    isArchived: row.isArchived,
    blockOnOpenPr: row.blockOnOpenPr,
    forcePushToDefault: row.forcePushToDefault,
    defaultAiProvider: row.defaultAiProvider,
    settings: row.settings,
    connectionId: row.connectionId,
    discoveredRepositoryId: row.discoveredRepositoryId,
    providerRepoId: row.providerRepoId,
    instanceUrl: row.instanceUrl,
    visibility: row.visibility,
    workspaceStatus: row.workspaceStatus,
    lastSyncAt: row.lastSyncAt,
    lastCloneAt: row.lastCloneAt,
    lastError: row.lastError,
    lastHealthCheckAt: row.lastHealthCheckAt,
    healthStatus: row.healthStatus,
    healthMessage: row.healthMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getRepository(id: string) {
  const db = getDb()
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1)
  if (!row) throw new AppError(404, 'Repository not found', 'not_found')
  return publicRepo(row)
}

export async function createRepository(
  input: z.infer<typeof createRepositorySchema>,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const parsed = createRepositorySchema.parse(input)
  const remote = validateRemoteUrl(parsed.remoteUrl)
  if (!remote.ok) throw new AppError(400, remote.reason, 'invalid_remote')

  const settings = await getSettings()
  const workspaceId = newWorkspaceId()
  let localPath: string | null = managedWorkspacePath(workspaceId)

  if (parsed.allowHostPath && parsed.localPath) {
    // Compatibility mode for imported host clones — admin only path should be checked by caller
    if (parsed.localPath.includes('..') || !parsed.localPath.startsWith('/')) {
      throw new AppError(400, 'Invalid local path', 'invalid_path')
    }
    localPath = parsed.localPath
  }

  const db = getDb()
  try {
    const [row] = await db.insert(repositories).values({
      name: parsed.name,
      forgeType: parsed.forgeType,
      remoteUrl: remote.normalized,
      canonicalProjectIdentifier: parsed.canonicalProjectIdentifier,
      workspaceId,
      localPath,
      defaultBranch: parsed.defaultBranch,
      isEnabled: parsed.activate,
      blockOnOpenPr: parsed.blockOnOpenPr ?? settings.defaultBlockOnOpenPr,
      forcePushToDefault: parsed.forcePushToDefault ?? false,
      defaultAiProvider: parsed.defaultAiProvider ?? settings.defaultAiProvider,
    }).returning()

    await writeAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      action: 'repository.create',
      targetType: 'repository',
      targetId: row.id,
      metadata: { name: row.name, forgeType: row.forgeType, activated: row.isEnabled },
      ipHash,
    })

    await exportWorkerConfig(actor)
    return publicRepo(row)
  } catch (err: unknown) {
    if (String(err).includes('unique') || String(err).includes('duplicate')) {
      throw new AppError(409, 'Repository already exists', 'duplicate')
    }
    throw err
  }
}

export async function updateRepository(
  id: string,
  input: z.infer<typeof updateRepositorySchema>,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const parsed = updateRepositorySchema.parse(input)
  const db = getDb()
  const [existing] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1)
  if (!existing || existing.isArchived) throw new AppError(404, 'Repository not found', 'not_found')

  let remoteUrl = existing.remoteUrl
  if (parsed.remoteUrl) {
    const remote = validateRemoteUrl(parsed.remoteUrl)
    if (!remote.ok) throw new AppError(400, remote.reason, 'invalid_remote')
    remoteUrl = remote.normalized
  }

  const nextSettings = parsed.settings === undefined
    ? existing.settings
    : {
        ...(existing.settings || {}),
        ...parsed.settings,
        // Always persist customPrompt as a string (empty = no repo-specific prompt)
        customPrompt: typeof parsed.settings.customPrompt === 'string'
          ? parsed.settings.customPrompt
          : customPromptFromSettings(existing.settings),
      }

  const [row] = await db.update(repositories).set({
    remoteUrl,
    canonicalProjectIdentifier: parsed.canonicalProjectIdentifier ?? existing.canonicalProjectIdentifier,
    defaultBranch: parsed.defaultBranch ?? existing.defaultBranch,
    blockOnOpenPr: parsed.blockOnOpenPr ?? existing.blockOnOpenPr,
    forcePushToDefault: parsed.forcePushToDefault ?? existing.forcePushToDefault,
    defaultAiProvider: parsed.defaultAiProvider === undefined
      ? existing.defaultAiProvider
      : parsed.defaultAiProvider,
    settings: nextSettings,
    updatedAt: new Date(),
  }).where(eq(repositories.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'repository.update',
    targetType: 'repository',
    targetId: id,
    metadata: {
      fields: Object.keys(parsed),
      customPromptUpdated: parsed.settings?.customPrompt !== undefined,
      customPromptBytes: typeof nextSettings?.customPrompt === 'string'
        ? nextSettings.customPrompt.length
        : 0,
    },
    ipHash,
  })
  await exportWorkerConfig(actor)
  return publicRepo(row)
}

export async function setRepositoriesEnabledBulk(
  input: z.infer<typeof bulkSetEnabledSchema>,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const parsed = bulkSetEnabledSchema.parse(input)
  const db = getDb()

  const conditions = [
    eq(repositories.isArchived, false),
    eq(repositories.isEnabled, !parsed.enabled),
  ]
  if (parsed.connectionId) conditions.push(eq(repositories.connectionId, parsed.connectionId))
  if (parsed.forgeType) conditions.push(eq(repositories.forgeType, parsed.forgeType))
  if (parsed.workspaceStatus) {
    conditions.push(eq(
      repositories.workspaceStatus,
      parsed.workspaceStatus as typeof repositories.$inferSelect.workspaceStatus,
    ))
  }
  if (parsed.q) {
    conditions.push(or(
      ilike(repositories.name, `%${parsed.q}%`),
      ilike(repositories.remoteUrl, `%${parsed.q}%`),
      ilike(repositories.canonicalProjectIdentifier, `%${parsed.q}%`),
    )!)
  }
  // Do not enable hard-failed workspaces in bulk (same gate as single enable).
  if (parsed.enabled) {
    conditions.push(notInArray(repositories.workspaceStatus, ['failed', 'inaccessible']))
  }

  const updated = await db.update(repositories).set({
    isEnabled: parsed.enabled,
    updatedAt: new Date(),
  }).where(and(...conditions)).returning({ id: repositories.id })

  if (parsed.enabled && updated.length) {
    // Best-effort labels so polling can start; do not fail the bulk op.
    for (const row of updated.slice(0, 50)) {
      try {
        await ensureRepositoryLabels(row.id, { strict: false })
      } catch {
        // ignore
      }
    }
  }

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: parsed.enabled ? 'repository.bulk_enable' : 'repository.bulk_disable',
    targetType: 'repository',
    targetId: parsed.connectionId || 'all',
    metadata: {
      enabled: parsed.enabled,
      updated: updated.length,
      connectionId: parsed.connectionId,
      forgeType: parsed.forgeType,
      q: parsed.q,
      workspaceStatus: parsed.workspaceStatus,
    },
    ipHash,
  })

  if (updated.length) {
    await exportWorkerConfig(actor)
  }

  return { updated: updated.length, enabled: parsed.enabled }
}

export async function setRepositoryEnabled(
  id: string,
  enabled: boolean,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const db = getDb()
  const [existing] = await db.select().from(repositories).where(and(
    eq(repositories.id, id),
    eq(repositories.isArchived, false),
  )).limit(1)
  if (!existing) throw new AppError(404, 'Repository not found', 'not_found')

  if (enabled) {
    if (!existing.localPath) {
      throw new AppError(400, 'Repository has no workspace path', 'workspace_missing')
    }
    // Lazy clone: not_cloned / ready are OK. Block only hard failures mid-flight.
    if (['failed', 'inaccessible'].includes(existing.workspaceStatus)) {
      throw new AppError(
        400,
        `Workspace is ${existing.workspaceStatus}; clone or repair before enabling`,
        'workspace_not_ready',
      )
    }
  }

  const [row] = await db.update(repositories).set({
    isEnabled: enabled,
    updatedAt: new Date(),
  }).where(eq(repositories.id, id)).returning()

  if (enabled) {
    // Worker needs AI labels present before polling begins
    await ensureRepositoryLabels(id, { strict: false })
  }

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: enabled ? 'repository.enable' : 'repository.disable',
    targetType: 'repository',
    targetId: id,
    ipHash,
  })
  await exportWorkerConfig(actor)
  return publicRepo(row)
}

export async function archiveRepository(
  id: string,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const db = getDb()
  const [row] = await db.update(repositories).set({
    isArchived: true,
    isEnabled: false,
    updatedAt: new Date(),
  }).where(eq(repositories.id, id)).returning()
  if (!row) throw new AppError(404, 'Repository not found', 'not_found')

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'repository.archive',
    targetType: 'repository',
    targetId: id,
    ipHash,
  })
  await exportWorkerConfig(actor)
  return publicRepo(row)
}

export async function testRepositoryConnection(id: string) {
  const db = getDb()
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1)
  if (!row) throw new AppError(404, 'Repository not found', 'not_found')

  const { access } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
  let healthMessage = 'OK'

  try {
    if (!row.localPath) {
      healthStatus = 'unhealthy'
      healthMessage = 'No local path configured'
    } else {
      await access(row.localPath)
      const { stdout } = await execFileAsync('git', ['-C', row.localPath, 'rev-parse', '--is-inside-work-tree'], {
        timeout: 10000,
      })
      if (stdout.trim() !== 'true') {
        healthStatus = 'unhealthy'
        healthMessage = 'Path is not a git repository'
      } else {
        try {
          const remote = await execFileAsync('git', ['-C', row.localPath, 'remote', 'get-url', 'origin'], {
            timeout: 10000,
          })
          const origin = remote.stdout.trim()
          if (origin && row.remoteUrl && !originsMatch(origin, row.remoteUrl)) {
            healthStatus = 'degraded'
            healthMessage = `Origin mismatch: ${origin}`
          }
        } catch {
          healthStatus = 'degraded'
          healthMessage = 'Could not read git origin'
        }
      }
    }
  } catch {
    healthStatus = 'unhealthy'
    healthMessage = 'Local path missing or inaccessible'
  }

  const workspaceStatus: typeof repositories.$inferSelect.workspaceStatus
    = healthStatus === 'healthy' || healthStatus === 'degraded'
      ? 'ready'
      : row.workspaceStatus === 'ready'
        ? 'failed'
        : row.workspaceStatus

  const [updated] = await db.update(repositories).set({
    healthStatus,
    healthMessage: healthMessage ? healthMessage.slice(0, 2000) : healthMessage,
    lastHealthCheckAt: new Date(),
    workspaceStatus,
    lastError: healthStatus === 'unhealthy' ? healthMessage : null,
    updatedAt: new Date(),
  }).where(eq(repositories.id, id)).returning()

  return publicRepo(updated)
}

function originsMatch(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
  return norm(a) === norm(b)
}

export async function repositoryRecentRuns(id: string, limit = 10) {
  const db = getDb()
  return db.select().from(taskRuns)
    .where(eq(taskRuns.repositoryId, id))
    .orderBy(desc(taskRuns.createdAt))
    .limit(limit)
}

export async function repositoryCounts() {
  const db = getDb()
  const [total] = await db.select({ c: count() }).from(repositories).where(eq(repositories.isArchived, false))
  const [enabled] = await db.select({ c: count() }).from(repositories).where(and(
    eq(repositories.isArchived, false),
    eq(repositories.isEnabled, true),
  ))
  const [unhealthy] = await db.select({ c: count() }).from(repositories).where(and(
    eq(repositories.isArchived, false),
    eq(repositories.healthStatus, 'unhealthy'),
  ))
  return {
    total: total?.c ?? 0,
    enabled: enabled?.c ?? 0,
    unhealthy: unhealthy?.c ?? 0,
  }
}
