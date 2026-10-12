import { and, count, desc, eq, ilike, or } from 'drizzle-orm'
import { discoveredRepositories, forgeConnections, repositories } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { redactSecrets } from '#utils/redact'
import { getConnectionAccessToken } from './connections'
import {
  GITHUB_FINE_GRAINED_NO_PRIVATE_HINT,
  GITHUB_PRIVATE_ACCESS_HINT,
  fetchGitHubAccount,
  githubClassicTokenCanAccessPrivate,
  listGitHubRepositories,
} from './forge-github'
import {
  GITLAB_PRIVATE_ACCESS_HINT,
  fetchGitLabAccount,
  gitlabTokenCanAccessPrivate,
  listGitLabProjects,
} from './forge-gitlab'
import { ensureLabelsForConnectionRepositories } from './ai-labels'
import { writeAudit } from './audit'
import type { ForgeRepo } from './forge-types'

export function publicDiscovered(
  row: typeof discoveredRepositories.$inferSelect,
  registeredRepoId?: string | null,
  connection?: {
    provider: 'github' | 'gitlab'
    displayName: string | null
    accountLogin: string | null
    instanceUrl: string
  } | null,
) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    provider: connection?.provider ?? null,
    connectionDisplayName: connection?.displayName || connection?.accountLogin || null,
    instanceUrl: connection?.instanceUrl ?? null,
    providerRepoId: row.providerRepoId,
    fullName: row.fullName,
    ownerLogin: row.ownerLogin,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
    cloneUrlHttps: row.cloneUrlHttps,
    htmlUrl: row.htmlUrl,
    permissions: row.permissions,
    isArchived: row.isArchived,
    isFork: row.isFork,
    lastDiscoveredAt: row.lastDiscoveredAt,
    registeredRepositoryId: registeredRepoId ?? null,
    isRegistered: Boolean(registeredRepoId),
  }
}

export async function syncConnectionRepositories(
  connectionId: string,
  opts?: { actorUserId?: string, actorUsername?: string },
) {
  const { token, row: connection } = await getConnectionAccessToken(connectionId)
  if (connection.status === 'disconnected') {
    throw new AppError(400, 'Connection is disconnected', 'disconnected')
  }

  let repos: ForgeRepo[]
  let detectedScopes: string | null = connection.scopes
  const isPat = Boolean(connection.scopes?.includes('personal_access_token'))
  const isGitHubFineGrained = connection.provider === 'github' && token.startsWith('github_pat_')
  try {
    // Refresh real token scopes (older connects may have stored a guessed label).
    if (connection.provider === 'github') {
      const account = await fetchGitHubAccount(token)
      if (isGitHubFineGrained) {
        detectedScopes = isPat
          ? `personal_access_token fine-grained${account.scopes ? ` ${account.scopes}` : ''}`
          : `fine-grained${account.scopes ? ` ${account.scopes}` : ''}`
      } else if (account.scopes) {
        detectedScopes = isPat ? `personal_access_token classic ${account.scopes}` : account.scopes
      }
      repos = await listGitHubRepositories(token)
    } else {
      const account = await fetchGitLabAccount(connection.instanceUrl, token)
      if (account.scopes) {
        detectedScopes = isPat ? `personal_access_token ${account.scopes}` : account.scopes
      }
      repos = await listGitLabProjects(connection.instanceUrl, token)
    }
  } catch (err) {
    const db = getDb()
    const message = redactSecrets(err instanceof Error ? err.message : 'Repository sync failed')
    await db.update(forgeConnections).set({
      status: 'error',
      lastError: message,
      updatedAt: new Date(),
    }).where(eq(forgeConnections.id, connectionId))
    throw err
  }

  const db = getDb()
  const seenIds: string[] = []
  const now = new Date()

  for (const repo of repos) {
    seenIds.push(repo.providerRepoId)
    const [existing] = await db.select().from(discoveredRepositories).where(and(
      eq(discoveredRepositories.connectionId, connectionId),
      eq(discoveredRepositories.providerRepoId, repo.providerRepoId),
    )).limit(1)

    if (existing) {
      await db.update(discoveredRepositories).set({
        fullName: repo.fullName,
        ownerLogin: repo.ownerLogin,
        name: repo.name,
        description: repo.description,
        visibility: repo.visibility,
        defaultBranch: repo.defaultBranch,
        cloneUrlHttps: repo.cloneUrlHttps,
        htmlUrl: repo.htmlUrl,
        permissions: repo.permissions,
        isArchived: repo.isArchived,
        isFork: repo.isFork,
        lastDiscoveredAt: now,
        updatedAt: now,
      }).where(eq(discoveredRepositories.id, existing.id))
    } else {
      await db.insert(discoveredRepositories).values({
        connectionId,
        providerRepoId: repo.providerRepoId,
        fullName: repo.fullName,
        ownerLogin: repo.ownerLogin,
        name: repo.name,
        description: repo.description,
        visibility: repo.visibility,
        defaultBranch: repo.defaultBranch,
        cloneUrlHttps: repo.cloneUrlHttps,
        htmlUrl: repo.htmlUrl,
        permissions: repo.permissions,
        isArchived: repo.isArchived,
        isFork: repo.isFork,
        lastDiscoveredAt: now,
      })
    }

    // Refresh metadata on already-registered repos matched by provider identity
    await db.update(repositories).set({
      defaultBranch: repo.defaultBranch,
      visibility: repo.visibility,
      remoteUrl: repo.cloneUrlHttps.replace(/\.git$/, '') + '.git',
      canonicalProjectIdentifier: repo.fullName,
      updatedAt: now,
    }).where(and(
      eq(repositories.connectionId, connectionId),
      eq(repositories.providerRepoId, repo.providerRepoId),
      eq(repositories.isArchived, false),
    ))
  }

  // Mark registered repos that disappeared from discovery as degraded (do not delete)
  if (seenIds.length) {
    const registered = await db.select().from(repositories).where(and(
      eq(repositories.connectionId, connectionId),
      eq(repositories.isArchived, false),
    ))
    for (const reg of registered) {
      if (reg.providerRepoId && !seenIds.includes(reg.providerRepoId)) {
        await db.update(repositories).set({
          healthStatus: 'degraded',
          healthMessage: 'Repository no longer returned by provider discovery',
          updatedAt: now,
        }).where(eq(repositories.id, reg.id))
      }
    }
  }

  const privateCount = repos.filter((r) => r.visibility === 'private' || r.visibility === 'internal').length
  const publicCount = repos.length - privateCount
  const scopeParts = (detectedScopes || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'personal_access_token')
  let accessWarning: string | null = null
  // Only warn when scopes prove private listing is impossible (not when the account simply has none).
  if (connection.provider === 'github' && !isGitHubFineGrained && githubClassicTokenCanAccessPrivate(scopeParts) === false) {
    accessWarning = GITHUB_PRIVATE_ACCESS_HINT
  } else if (
    connection.provider === 'github'
    && isGitHubFineGrained
    && privateCount === 0
  ) {
    accessWarning = GITHUB_FINE_GRAINED_NO_PRIVATE_HINT
  } else if (
    connection.provider === 'gitlab'
    && gitlabTokenCanAccessPrivate(scopeParts.length ? scopeParts : null) === false
  ) {
    accessWarning = GITLAB_PRIVATE_ACCESS_HINT
  }

  await db.update(forgeConnections).set({
    status: 'active',
    lastError: accessWarning,
    lastSyncAt: now,
    lastValidatedAt: now,
    ...(detectedScopes ? { scopes: detectedScopes } : {}),
    updatedAt: now,
  }).where(eq(forgeConnections.id, connectionId))

  // Backfill AI work/review labels on already-registered repos for this connection
  const labels = await ensureLabelsForConnectionRepositories(connectionId)

  if (opts?.actorUserId) {
    await writeAudit({
      actorUserId: opts.actorUserId,
      actorUsername: opts.actorUsername,
      action: 'connection.refresh_repos',
      targetType: 'forge_connection',
      targetId: connectionId,
      metadata: {
        count: repos.length,
        privateCount,
        publicCount,
        accessWarning: Boolean(accessWarning),
        labelsEnsured: labels.ok,
        labelsFailed: labels.failed,
        labelsCreated: labels.created,
      },
    })
  }

  return {
    count: repos.length,
    publicCount,
    privateCount,
    syncedAt: now,
    accessWarning,
    labels,
  }
}

export async function listDiscoveredRepositories(opts: {
  connectionId?: string
  provider?: 'github' | 'gitlab'
  q?: string
  visibility?: string
  registered?: boolean
  page: number
  pageSize: number
}) {
  const db = getDb()
  const page = Math.max(1, opts.page)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize))
  const offset = (page - 1) * pageSize

  const conditions = []
  if (opts.connectionId) conditions.push(eq(discoveredRepositories.connectionId, opts.connectionId))
  if (opts.provider) conditions.push(eq(forgeConnections.provider, opts.provider))
  if (opts.visibility) conditions.push(eq(discoveredRepositories.visibility, opts.visibility))
  if (opts.q) {
    conditions.push(or(
      ilike(discoveredRepositories.fullName, `%${opts.q}%`),
      ilike(discoveredRepositories.name, `%${opts.q}%`),
      ilike(discoveredRepositories.ownerLogin, `%${opts.q}%`),
    ))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const rows = await db.select({
    discovered: discoveredRepositories,
    provider: forgeConnections.provider,
    connectionDisplayName: forgeConnections.displayName,
    connectionAccountLogin: forgeConnections.accountLogin,
    instanceUrl: forgeConnections.instanceUrl,
  }).from(discoveredRepositories)
    .innerJoin(forgeConnections, eq(discoveredRepositories.connectionId, forgeConnections.id))
    .where(where)
    .orderBy(desc(discoveredRepositories.lastDiscoveredAt))
    .limit(pageSize)
    .offset(offset)

  const [totalRow] = await db.select({ c: count() })
    .from(discoveredRepositories)
    .innerJoin(forgeConnections, eq(discoveredRepositories.connectionId, forgeConnections.id))
    .where(where)

  // Map registered repos for this page
  const registered = rows.length
    ? await db.select({
      id: repositories.id,
      providerRepoId: repositories.providerRepoId,
      connectionId: repositories.connectionId,
      discoveredRepositoryId: repositories.discoveredRepositoryId,
    }).from(repositories).where(eq(repositories.isArchived, false))
    : []

  const regMap = new Map<string, string>()
  for (const r of registered) {
    if (r.providerRepoId && r.connectionId) {
      regMap.set(`${r.connectionId}:${r.providerRepoId}`, r.id)
    }
    if (r.discoveredRepositoryId) {
      regMap.set(`disc:${r.discoveredRepositoryId}`, r.id)
    }
  }

  let mapped = rows.map(({ discovered, provider, connectionDisplayName, connectionAccountLogin, instanceUrl }) => {
    const rid = regMap.get(`disc:${discovered.id}`)
      || regMap.get(`${discovered.connectionId}:${discovered.providerRepoId}`)
      || null
    return publicDiscovered(discovered, rid, {
      provider,
      displayName: connectionDisplayName,
      accountLogin: connectionAccountLogin,
      instanceUrl,
    })
  })

  if (opts.registered === true) mapped = mapped.filter((m) => m.isRegistered)
  if (opts.registered === false) mapped = mapped.filter((m) => !m.isRegistered)

  return { items: mapped, page, pageSize, total: totalRow?.c ?? 0 }
}
