import { and, eq } from 'drizzle-orm'
import { discoveredRepositories, repositories } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { redactSecrets } from '#utils/redact'
import { AI_WORKER_LABELS } from './ai-labels-def'
import { getConnectionAccessToken } from './connections'
import { ensureGitHubRepoLabels } from './forge-github'
import { ensureGitLabProjectLabels } from './forge-gitlab'

export { AI_WORKER_LABELS } from './ai-labels-def'
export type { AiWorkerLabel } from './ai-labels-def'

export type EnsureLabelsResult = {
  ok: boolean
  ensured: number
  created?: number
  existing?: number
  skipped: boolean
  reason?: string
  message?: string
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

export function canManageLabels(permissions: unknown, provider: 'github' | 'gitlab'): boolean {
  if (!permissions || typeof permissions !== 'object') return true
  const p = permissions as Record<string, unknown>
  if (provider === 'github') {
    if (p.admin === true || p.push === true) return true
    if (p.admin === false && p.push === false) return false
    return true
  }
  const level = typeof p.accessLevel === 'number' ? p.accessLevel : null
  if (level === null) return true
  // Developer (30+) can manage labels on GitLab
  return level >= 30
}

/**
 * Create missing AI worker / AI review labels on a forge project using a connection token.
 */
export async function ensureLabelsOnForgeProject(opts: {
  provider: 'github' | 'gitlab'
  instanceUrl: string
  token: string
  fullName: string
}): Promise<{ created: number, existing: number }> {
  if (opts.provider === 'github') {
    return ensureGitHubRepoLabels(opts.token, opts.fullName, AI_WORKER_LABELS)
  }
  return ensureGitLabProjectLabels(opts.instanceUrl, opts.token, opts.fullName, AI_WORKER_LABELS)
}

/**
 * Create or update all AI worker / AI review labels on a registered repository.
 * Best-effort when called from background sync; throws when `strict` (manual UI).
 */
export async function ensureRepositoryLabels(
  repositoryId: string,
  opts?: { strict?: boolean },
): Promise<EnsureLabelsResult> {
  const strict = Boolean(opts?.strict)
  const db = getDb()
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1)
  if (!repo || repo.isArchived) {
    if (strict) throw new AppError(404, 'Repository not found', 'not_found')
    return { ok: false, ensured: 0, skipped: true, reason: 'not_found' }
  }

  const projectRef = resolveProjectRef(repo)
  if (!projectRef) {
    const message = 'Repository has no project identifier for label setup'
    if (strict) throw new AppError(400, message, 'missing_project_ref')
    return { ok: false, ensured: 0, skipped: true, reason: 'missing_project_ref', message }
  }

  if (!repo.connectionId) {
    const message = 'Repository is not linked to a forge connection; reconnect or register via Connections'
    if (strict) throw new AppError(400, message, 'missing_connection')
    return { ok: false, ensured: 0, skipped: true, reason: 'missing_connection', message }
  }

  try {
    const { token, row: connection } = await getConnectionAccessToken(repo.connectionId)
    const result = await ensureLabelsOnForgeProject({
      provider: connection.provider,
      instanceUrl: connection.instanceUrl,
      token,
      fullName: projectRef,
    })
    return {
      ok: true,
      ensured: AI_WORKER_LABELS.length,
      created: result.created,
      existing: result.existing,
      skipped: false,
    }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : 'Label setup failed')
    if (strict) {
      if (err instanceof AppError) throw err
      throw new AppError(500, message, 'setup_labels_failed')
    }
    return { ok: false, ensured: 0, skipped: false, reason: 'error', message }
  }
}

/**
 * Ensure AI labels on every discovered (and registered) project for a connection.
 * Runs after connection refresh / project list sync so labels exist before you open issues.
 */
export async function ensureLabelsForConnectionRepositories(
  connectionId: string,
): Promise<{ attempted: number, ok: number, failed: number, created: number }> {
  const { token, row: connection } = await getConnectionAccessToken(connectionId)
  const db = getDb()

  const discovered = await db.select().from(discoveredRepositories).where(and(
    eq(discoveredRepositories.connectionId, connectionId),
    eq(discoveredRepositories.isArchived, false),
  ))

  // Also cover registered repos that may not appear in discovery (legacy)
  const registered = await db.select().from(repositories).where(and(
    eq(repositories.connectionId, connectionId),
    eq(repositories.isArchived, false),
  ))

  const targets = new Map<string, { fullName: string, permissions: unknown }>()
  for (const disc of discovered) {
    if (!canManageLabels(disc.permissions, connection.provider)) continue
    targets.set(disc.fullName.toLowerCase(), {
      fullName: disc.fullName,
      permissions: disc.permissions,
    })
  }
  for (const repo of registered) {
    const ref = resolveProjectRef(repo)
    if (!ref) continue
    const key = ref.toLowerCase()
    if (!targets.has(key)) {
      targets.set(key, { fullName: ref, permissions: null })
    }
  }

  let ok = 0
  let failed = 0
  let created = 0
  for (const target of targets.values()) {
    try {
      const result = await ensureLabelsOnForgeProject({
        provider: connection.provider,
        instanceUrl: connection.instanceUrl,
        token,
        fullName: target.fullName,
      })
      ok += 1
      created += result.created
    } catch {
      failed += 1
    }
  }

  return { attempted: targets.size, ok, failed, created }
}
