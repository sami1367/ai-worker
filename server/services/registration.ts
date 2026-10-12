import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { discoveredRepositories, forgeConnections, repositories } from '#db/schema'
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
  discoveredRepositoryIds: z.array(z.string().uuid()).min(1).max(50),
  enable: z.boolean().default(false),
  blockOnOpenPr: z.boolean().optional(),
  defaultAiProvider: z.enum(['cursor', 'claude']).nullable().optional(),
})

function workerNameFromFullName(fullName: string): string {
  // Worker conf historically uses short names; prefer last path segment, fall back to sanitized full path
  const parts = fullName.split('/').filter(Boolean)
  const base = parts[parts.length - 1] || fullName
  return base.slice(0, 128)
}

export async function registerDiscoveredRepositories(
  input: z.infer<typeof registerDiscoveredSchema>,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const parsed = registerDiscoveredSchema.parse(input)
  const db = getDb()
  const settings = await getSettings()
  const created = []
  const skipped: Array<{ id: string, reason: string }> = []

  for (const discoveredId of parsed.discoveredRepositoryIds) {
    const [disc] = await db.select().from(discoveredRepositories)
      .where(eq(discoveredRepositories.id, discoveredId))
      .limit(1)
    if (!disc) {
      skipped.push({ id: discoveredId, reason: 'not_found' })
      continue
    }

    const [connection] = await db.select().from(forgeConnections)
      .where(eq(forgeConnections.id, disc.connectionId))
      .limit(1)
    if (!connection || connection.status === 'disconnected') {
      skipped.push({ id: discoveredId, reason: 'connection_unavailable' })
      continue
    }

    // Match existing by provider identity first
    const [byIdentity] = await db.select().from(repositories).where(and(
      eq(repositories.forgeType, connection.provider),
      eq(repositories.providerRepoId, disc.providerRepoId),
      eq(repositories.instanceUrl, connection.instanceUrl),
    )).limit(1)

    if (byIdentity && !byIdentity.isArchived) {
      skipped.push({ id: discoveredId, reason: 'already_registered', })
      // Ensure link is present
      await db.update(repositories).set({
        connectionId: connection.id,
        discoveredRepositoryId: disc.id,
        updatedAt: new Date(),
      }).where(eq(repositories.id, byIdentity.id))
      // Previous/already-registered repos may be missing AI labels
      await ensureRepositoryLabels(byIdentity.id, { strict: false })
      continue
    }

    // Ambiguous legacy match by remote URL — require explicit resolution if name collision differs
    const remote = validateRemoteUrl(disc.cloneUrlHttps)
    if (!remote.ok) {
      skipped.push({ id: discoveredId, reason: 'invalid_remote' })
      continue
    }

    let name = workerNameFromFullName(disc.fullName)
    const [nameClash] = await db.select().from(repositories).where(and(
      eq(repositories.name, name),
      eq(repositories.forgeType, connection.provider),
    )).limit(1)
    if (nameClash && !nameClash.isArchived) {
      // Prefer full path style when short name conflicts
      name = disc.fullName.replace(/[^\w./-]+/g, '-').slice(0, 128)
      const [stillClash] = await db.select().from(repositories).where(and(
        eq(repositories.name, name),
        eq(repositories.forgeType, connection.provider),
      )).limit(1)
      if (stillClash && !stillClash.isArchived) {
        // If legacy row has same remote, link it instead of duplicating
        if (stillClash.remoteUrl && stillClash.remoteUrl.replace(/\.git$/, '') === remote.normalized.replace(/\.git$/, '')) {
          await db.update(repositories).set({
            connectionId: connection.id,
            discoveredRepositoryId: disc.id,
            providerRepoId: disc.providerRepoId,
            instanceUrl: connection.instanceUrl,
            visibility: disc.visibility,
            canonicalProjectIdentifier: disc.fullName,
            updatedAt: new Date(),
          }).where(eq(repositories.id, stillClash.id))
          skipped.push({ id: discoveredId, reason: 'linked_legacy' })
          await ensureRepositoryLabels(stillClash.id, { strict: false })
          continue
        }
        skipped.push({ id: discoveredId, reason: 'name_conflict' })
        continue
      }
    }

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
      isEnabled: parsed.enable,
      blockOnOpenPr: parsed.blockOnOpenPr ?? settings.defaultBlockOnOpenPr,
      defaultAiProvider: parsed.defaultAiProvider ?? settings.defaultAiProvider,
      connectionId: connection.id,
      discoveredRepositoryId: disc.id,
      providerRepoId: disc.providerRepoId,
      instanceUrl: connection.instanceUrl,
      visibility: disc.visibility,
      workspaceStatus: 'queued',
    }).returning()

    await writeAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      action: 'repository.register_discovered',
      targetType: 'repository',
      targetId: row.id,
      metadata: {
        fullName: disc.fullName,
        provider: connection.provider,
        connectionId: connection.id,
      },
      ipHash,
    })

    await queueWorkspaceOperation({
      repositoryId: row.id,
      operationType: 'clone',
      actor,
    })

    // Ensure AI work + AI review labels exist on the forge (does not need local clone)
    await ensureRepositoryLabels(row.id, { strict: false })

    created.push(publicRepo(row))
  }

  await exportWorkerConfig(actor)
  return { created, skipped }
}

export async function unregisterRepository(
  id: string,
  actor: { id: string, username: string },
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
    actorUserId: actor.id,
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
