import { and, eq } from 'drizzle-orm'
import { repositories } from '#db/schema'
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
    if (connection.provider === 'github') {
      await ensureGitHubRepoLabels(token, projectRef, AI_WORKER_LABELS)
    } else {
      await ensureGitLabProjectLabels(connection.instanceUrl, token, projectRef, AI_WORKER_LABELS)
    }
    return { ok: true, ensured: AI_WORKER_LABELS.length, skipped: false }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : 'Label setup failed')
    if (strict) {
      if (err instanceof AppError) throw err
      throw new AppError(500, message, 'setup_labels_failed')
    }
    return { ok: false, ensured: 0, skipped: false, reason: 'error', message }
  }
}

/** Ensure labels on all non-archived repos for a connection (e.g. after discovery refresh). */
export async function ensureLabelsForConnectionRepositories(
  connectionId: string,
): Promise<{ attempted: number, ok: number, failed: number }> {
  const db = getDb()
  const rows = await db.select({ id: repositories.id }).from(repositories).where(and(
    eq(repositories.connectionId, connectionId),
    eq(repositories.isArchived, false),
  ))

  let ok = 0
  let failed = 0
  for (const row of rows) {
    const result = await ensureRepositoryLabels(row.id, { strict: false })
    if (result.ok) ok += 1
    else if (!result.skipped) failed += 1
  }
  return { attempted: rows.length, ok, failed }
}
