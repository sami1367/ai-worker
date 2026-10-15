import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { discoveredRepositories, forgeConnections, repositories, settings, workspaceOperations } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { managedWorkspacePath, newWorkspaceId, validateRemoteUrl } from '#utils/paths'
import { getSettings } from './settings'
import { writeAudit } from './audit'
import { ensureRepositoryLabels } from './ai-labels'
import { exportWorkerConfig } from './config-sync'
import { publicRepo } from './repositories'
import { queueWorkspaceOperation } from './workspace-manager'

export const registerDiscoveredSchema = z.object({
  discoveredRepositoryIds: z.array(z.string().uuid()).min(1).max(200),
  /** Default true: connect forge → manage repos without dashboard selection. */
  enable: z.boolean().default(true),
  /** Default false: clone only when an AI job needs the workspace. */
  clone: z.boolean().default(false),
  blockOnOpenPr: z.boolean().optional(),
  defaultAiProvider: z.enum(['cursor', 'claude', 'codex', 'gemini', 'copilot']).nullable().optional(),
})

function workerNameFromFullName(fullName: string): string {
  // Worker conf historically uses short names; prefer last path segment, fall back to sanitized full path
  const parts = fullName.split('/').filter(Boolean)
  const base = parts[parts.length - 1] || fullName
  return base.slice(0, 128)
}

/** Stable unique worker name so every forge repo can be managed (no silent name_conflict drops). */
async function allocateUniqueWorkerName(
  fullName: string,
  forgeType: 'github' | 'gitlab',
  providerRepoId: string,
): Promise<string> {
  const db = getDb()
  const candidates = [
    workerNameFromFullName(fullName),
    fullName.replace(/[^\w./-]+/g, '-').slice(0, 128),
    `${workerNameFromFullName(fullName)}-${providerRepoId}`.slice(0, 128),
    `${fullName.replace(/[^\w./-]+/g, '-')}-${providerRepoId}`.slice(0, 128),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    const [clash] = await db.select({ id: repositories.id }).from(repositories).where(and(
      eq(repositories.name, candidate),
      eq(repositories.forgeType, forgeType),
    )).limit(1)
    if (!clash) return candidate
  }

  // Last resort: deterministic unique slug
  return `${forgeType}-${providerRepoId}`.slice(0, 128)
}

type Actor = { id?: string | null, username: string }

async function registerOneDiscovered(
  discoveredId: string,
  opts: {
    enable: boolean
    clone: boolean
    blockOnOpenPr?: boolean
    defaultAiProvider?: 'cursor' | 'claude' | 'codex' | 'gemini' | 'copilot' | null
    actor: Actor
    ipHash?: string
    settings: Awaited<ReturnType<typeof getSettings>>
    /** When false, skip per-repo label API calls (bulk sync uses connection-level ensure). */
    ensureLabels?: boolean
  },
): Promise<
  | { kind: 'created', repo: ReturnType<typeof publicRepo> }
  | { kind: 'skipped', id: string, reason: string }
> {
  const db = getDb()
  const ensureLabels = opts.ensureLabels !== false
  const [disc] = await db.select().from(discoveredRepositories)
    .where(eq(discoveredRepositories.id, discoveredId))
    .limit(1)
  if (!disc) {
    return { kind: 'skipped', id: discoveredId, reason: 'not_found' }
  }

  const [connection] = await db.select().from(forgeConnections)
    .where(eq(forgeConnections.id, disc.connectionId))
    .limit(1)
  if (!connection || connection.status === 'disconnected') {
    return { kind: 'skipped', id: discoveredId, reason: 'connection_unavailable' }
  }

  const remote = validateRemoteUrl(disc.cloneUrlHttps)
  if (!remote.ok) {
    return { kind: 'skipped', id: discoveredId, reason: 'invalid_remote' }
  }

  // Match existing by provider identity first (including previously unregistered/archived)
  const [byIdentity] = await db.select().from(repositories).where(and(
    eq(repositories.forgeType, connection.provider),
    eq(repositories.providerRepoId, disc.providerRepoId),
    eq(repositories.instanceUrl, connection.instanceUrl),
  )).limit(1)

  if (byIdentity) {
    const restore = byIdentity.isArchived
    const [updated] = await db.update(repositories).set({
      connectionId: connection.id,
      discoveredRepositoryId: disc.id,
      remoteUrl: remote.normalized,
      canonicalProjectIdentifier: disc.fullName,
      defaultBranch: disc.defaultBranch || byIdentity.defaultBranch || 'main',
      visibility: disc.visibility,
      ...(restore
        ? {
            isArchived: false,
            isEnabled: opts.enable,
            // Keep existing ready workspace; otherwise stay lazy
            workspaceStatus: byIdentity.workspaceStatus === 'ready' ? 'ready' as const : 'not_cloned' as const,
          }
        : {}),
      updatedAt: new Date(),
    }).where(eq(repositories.id, byIdentity.id)).returning()

    if (ensureLabels) {
      await ensureRepositoryLabels(byIdentity.id, { strict: false })
    }
    if (restore) {
      return { kind: 'created', repo: publicRepo(updated) }
    }
    return { kind: 'skipped', id: discoveredId, reason: 'already_registered' }
  }

  // Ambiguous legacy match by remote URL
  const [byRemote] = await db.select().from(repositories).where(and(
    eq(repositories.forgeType, connection.provider),
    eq(repositories.remoteUrl, remote.normalized),
    eq(repositories.isArchived, false),
  )).limit(1)
  if (byRemote) {
    await db.update(repositories).set({
      connectionId: connection.id,
      discoveredRepositoryId: disc.id,
      providerRepoId: disc.providerRepoId,
      instanceUrl: connection.instanceUrl,
      visibility: disc.visibility,
      canonicalProjectIdentifier: disc.fullName,
      defaultBranch: disc.defaultBranch || byRemote.defaultBranch || 'main',
      updatedAt: new Date(),
    }).where(eq(repositories.id, byRemote.id))
    if (ensureLabels) {
      await ensureRepositoryLabels(byRemote.id, { strict: false })
    }
    return { kind: 'skipped', id: discoveredId, reason: 'linked_legacy' }
  }

  const name = await allocateUniqueWorkerName(disc.fullName, connection.provider, disc.providerRepoId)
  const workspaceId = newWorkspaceId()
  const localPath = managedWorkspacePath(workspaceId)

  const [row] = await db.insert(repositories).values({
    name,
    forgeType: connection.provider,
    remoteUrl: remote.normalized,
    canonicalProjectIdentifier: disc.fullName,
    workspaceId,
    localPath,
    defaultBranch: disc.defaultBranch || 'main',
    isEnabled: opts.enable,
    blockOnOpenPr: opts.blockOnOpenPr ?? opts.settings.defaultBlockOnOpenPr,
    defaultAiProvider: opts.defaultAiProvider ?? opts.settings.defaultAiProvider,
    connectionId: connection.id,
    discoveredRepositoryId: disc.id,
    providerRepoId: disc.providerRepoId,
    instanceUrl: connection.instanceUrl,
    visibility: disc.visibility,
    workspaceStatus: opts.clone ? 'queued' : 'not_cloned',
  }).returning()

  await writeAudit({
    actorUserId: opts.actor.id || null,
    actorUsername: opts.actor.username,
    action: 'repository.register_discovered',
    targetType: 'repository',
    targetId: row.id,
    metadata: {
      fullName: disc.fullName,
      provider: connection.provider,
      connectionId: connection.id,
      clone: opts.clone,
      enable: opts.enable,
    },
    ipHash: opts.ipHash,
  })

  if (opts.clone) {
    await queueWorkspaceOperation({
      repositoryId: row.id,
      operationType: 'clone',
      actor: opts.actor,
    })
  }

  if (ensureLabels) {
    await ensureRepositoryLabels(row.id, { strict: false })
  }

  return { kind: 'created', repo: publicRepo(row) }
}

export async function registerDiscoveredRepositories(
  input: z.infer<typeof registerDiscoveredSchema>,
  actor: Actor,
  ipHash?: string,
) {
  const parsed = registerDiscoveredSchema.parse(input)
  const settings = await getSettings()
  const created = []
  const skipped: Array<{ id: string, reason: string }> = []

  for (const discoveredId of parsed.discoveredRepositoryIds) {
    const result = await registerOneDiscovered(discoveredId, {
      enable: parsed.enable,
      clone: parsed.clone,
      blockOnOpenPr: parsed.blockOnOpenPr,
      defaultAiProvider: parsed.defaultAiProvider,
      actor,
      ipHash,
      settings,
    })
    if (result.kind === 'created') created.push(result.repo)
    else skipped.push({ id: result.id, reason: result.reason })
  }

  await exportWorkerConfig(actor)
  return { created, skipped }
}

/**
 * System default: register every discovered repo for a connection without cloning.
 * Safe to call repeatedly (idempotent).
 */
export async function autoRegisterDiscoveredForConnection(
  connectionId: string,
  actor?: Actor,
  opts?: { enable?: boolean },
) {
  const db = getDb()
  const settings = await getSettings()
  const systemActor: Actor = actor || { id: null, username: 'system' }
  const enable = opts?.enable !== false

  const discovered = await db.select({ id: discoveredRepositories.id })
    .from(discoveredRepositories)
    .where(and(
      eq(discoveredRepositories.connectionId, connectionId),
      eq(discoveredRepositories.isArchived, false),
    ))

  const created = []
  const skipped: Array<{ id: string, reason: string }> = []

  for (const disc of discovered) {
    const result = await registerOneDiscovered(disc.id, {
      enable,
      clone: false,
      actor: systemActor,
      settings,
      // Labels: discovery sync runs ensureLabelsForConnectionRepositories after bulk
      // register. Manual register keeps ensureLabels default (true) for immediate setup.
      ensureLabels: false,
    })
    if (result.kind === 'created') created.push(result.repo)
    else skipped.push({ id: result.id, reason: result.reason })
  }

  // Always re-export so every managed repo (old + new) is in worker conf with full_name.
  await exportWorkerConfig(actor)

  return {
    connectionId,
    created: created.length,
    skipped: skipped.length,
    createdRepos: created,
    skippedDetails: skipped,
  }
}

/**
 * One-time backfill: enable connection-linked repos left disabled by the old
 * "Add selected → clone → enable" flow. Runs once (settings flag).
 */
export async function enableConnectionLinkedRepositoriesOnce() {
  const db = getDb()
  const [flag] = await db.select().from(settings).where(eq(settings.key, 'lazyWorkspaceMigrated')).limit(1)
  if (flag?.value === true) {
    return { enabled: 0, skipped: true as const }
  }

  const updated = await db.update(repositories).set({
    isEnabled: true,
    updatedAt: new Date(),
  }).where(and(
    eq(repositories.isArchived, false),
    eq(repositories.isEnabled, false),
    isNotNull(repositories.connectionId),
  )).returning({ id: repositories.id })

  await db.insert(settings).values({
    key: 'lazyWorkspaceMigrated',
    value: true,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value: true, updatedAt: new Date() },
  })

  if (updated.length) {
    await exportWorkerConfig()
  }
  return { enabled: updated.length, skipped: false as const }
}

/**
 * Cancel not-yet-started clone ops so lazy-clone is the default for pending workspaces.
 * Leaves running clones alone.
 */
export async function deferPendingClones(actor?: Actor) {
  const db = getDb()
  const pending = await db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.operationType, 'clone'),
    eq(workspaceOperations.status, 'queued'),
  ))

  if (!pending.length) {
    return { cancelled: 0 }
  }

  const opIds = pending.map((p) => p.id)
  const repoIds = [...new Set(pending.map((p) => p.repositoryId))]

  await db.update(workspaceOperations).set({
    status: 'cancelled',
    finishedAt: new Date(),
    errorSummary: 'Deferred: clone on first AI job (lazy workspace)',
    updatedAt: new Date(),
  }).where(inArray(workspaceOperations.id, opIds))

  // Only mark not_cloned when still queued (not already cloning/ready)
  for (const repoId of repoIds) {
    await db.update(repositories).set({
      workspaceStatus: 'not_cloned',
      updatedAt: new Date(),
    }).where(and(
      eq(repositories.id, repoId),
      eq(repositories.workspaceStatus, 'queued'),
    ))
  }

  if (actor) {
    await writeAudit({
      actorUserId: actor.id || null,
      actorUsername: actor.username,
      action: 'workspace.defer_pending_clones',
      targetType: 'system',
      metadata: { cancelled: opIds.length, repositories: repoIds.length },
    })
  }

  return { cancelled: opIds.length, repositories: repoIds.length }
}

export async function unregisterRepository(
  id: string,
  actor: Actor,
  opts?: { deleteWorkspace?: boolean },
) {
  const db = getDb()
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1)
  if (!row || row.isArchived) throw new AppError(404, 'Repository not found', 'not_found')

  // Soft-remove registration: archive + disable; workspace deletion is explicit
  const [updated] = await db.update(repositories).set({
    isArchived: true,
    isEnabled: false,
    updatedAt: new Date(),
  }).where(eq(repositories.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id || null,
    actorUsername: actor.username,
    action: 'repository.unregister',
    targetType: 'repository',
    targetId: id,
    metadata: { deleteWorkspace: Boolean(opts?.deleteWorkspace) },
  })

  if (opts?.deleteWorkspace) {
    await queueWorkspaceOperation({
      repositoryId: id,
      operationType: 'delete_workspace',
      actor,
    })
  }

  await exportWorkerConfig(actor)
  return publicRepo(updated)
}
