import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { forgeConnections, repositories } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { decryptSecret, encryptSecret, safeEqual } from '#utils/crypto'
import { workerBaseDir } from '#utils/paths'
import { redactSecrets } from '#utils/redact'
import { writeAudit } from './audit'
import { getConnectionAccessToken } from './connections'
import { ensureGitHubRepoWebhook } from './forge-github'
import { ensureGitLabProjectWebhook } from './forge-gitlab'
import { recordWorkerEvent } from './worker'

/** Labels that should wake the worker when newly applied. */
export const WEBHOOK_TRIGGER_LABELS = new Set(['ai', 'ai-review'])

export type WebhookWorkHint = {
  provider: 'github' | 'gitlab'
  connectionId: string
  repositoryFullName: string | null
  providerRepoId: string | null
  kind: 'issue' | 'pull_request' | 'merge_request' | 'ping' | 'ignored'
  externalId: string | null
  labels: string[]
  action: string | null
  wokeWorker: boolean
}

function encryptionKey(): string {
  const key = process.env.SECRET_ENCRYPTION_KEY || ''
  if (!key) throw new AppError(500, 'SECRET_ENCRYPTION_KEY is not configured', 'misconfigured')
  return key
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
}

export function webhookCallbackUrl(provider: 'github' | 'gitlab', connectionId: string): string {
  return `${appBaseUrl()}/api/v1/webhooks/${provider}/${connectionId}`
}

export function wakePollPath(): string {
  return join(workerBaseDir(), 'state', 'wake-poll')
}

/** Touch a wake file so worker.sh breaks out of its sleep early. */
export async function wakeWorkerPoll(reason: string, metadata: Record<string, unknown> = {}) {
  const path = wakePollPath()
  await mkdir(dirname(path), { recursive: true })
  const body = `${JSON.stringify({
    at: new Date().toISOString(),
    reason,
    ...metadata,
  })}\n`
  await writeFile(path, body, { mode: 0o600 })
  await recordWorkerEvent({
    eventType: 'webhook.wake',
    message: `Webhook wake: ${reason}`,
    metadata: { reason, ...metadata },
  }).catch(() => {})
}

export function verifyGitHubSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')
  const provided = signatureHeader.slice('sha256='.length)
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function verifyGitLabToken(headerToken: string | undefined, secret: string): boolean {
  if (!headerToken) return false
  return safeEqual(headerToken, secret)
}

function labelNamesFromGitHub(payload: Record<string, unknown>): string[] {
  const label = payload.label as { name?: string } | undefined
  if (label?.name) return [String(label.name)]
  return []
}

function newlyAddedGitLabLabels(payload: Record<string, unknown>): string[] {
  const changes = payload.changes as {
    labels?: {
      previous?: Array<{ title?: string }>
      current?: Array<{ title?: string }>
    }
  } | undefined

  if (changes?.labels?.previous && changes?.labels?.current) {
    const prev = new Set(
      changes.labels.previous.map((l) => String(l.title || '').toLowerCase()).filter(Boolean),
    )
    return changes.labels.current
      .map((l) => String(l.title || ''))
      .filter((t) => t && !prev.has(t.toLowerCase()))
  }

  const attrs = payload.object_attributes as { action?: string } | undefined
  if (attrs?.action === 'open') {
    const labels = payload.labels as Array<{ title?: string }> | undefined
    return (labels || []).map((l) => String(l.title || '')).filter(Boolean)
  }

  return []
}

function hasTriggerLabel(labels: string[]): boolean {
  return labels.some((l) => WEBHOOK_TRIGGER_LABELS.has(l.toLowerCase()))
}

export function parseGitHubWebhookEvent(
  eventName: string | undefined,
  payload: Record<string, unknown>,
): Omit<WebhookWorkHint, 'provider' | 'connectionId' | 'wokeWorker'> {
  if (eventName === 'ping') {
    return {
      repositoryFullName: null,
      providerRepoId: null,
      kind: 'ping',
      externalId: null,
      labels: [],
      action: 'ping',
    }
  }

  const repo = payload.repository as { full_name?: string, id?: number | string } | undefined
  const action = typeof payload.action === 'string' ? payload.action : null
  const labels = labelNamesFromGitHub(payload)

  if (eventName === 'issues') {
    const issue = payload.issue as { number?: number } | undefined
    return {
      repositoryFullName: repo?.full_name ? String(repo.full_name) : null,
      providerRepoId: repo?.id != null ? String(repo.id) : null,
      kind: 'issue',
      externalId: issue?.number != null ? String(issue.number) : null,
      labels,
      action,
    }
  }

  if (eventName === 'pull_request') {
    const pr = payload.pull_request as { number?: number } | undefined
    return {
      repositoryFullName: repo?.full_name ? String(repo.full_name) : null,
      providerRepoId: repo?.id != null ? String(repo.id) : null,
      kind: 'pull_request',
      externalId: pr?.number != null ? String(pr.number) : null,
      labels,
      action,
    }
  }

  return {
    repositoryFullName: repo?.full_name ? String(repo.full_name) : null,
    providerRepoId: repo?.id != null ? String(repo.id) : null,
    kind: 'ignored',
    externalId: null,
    labels,
    action,
  }
}

export function parseGitLabWebhookEvent(
  payload: Record<string, unknown>,
): Omit<WebhookWorkHint, 'provider' | 'connectionId' | 'wokeWorker'> {
  const kindRaw = String(payload.object_kind || payload.event_type || '')
  const project = payload.project as { path_with_namespace?: string, id?: number | string } | undefined
  const attrs = payload.object_attributes as {
    action?: string
    iid?: number
  } | undefined
  const labels = newlyAddedGitLabLabels(payload)

  if (kindRaw === 'issue') {
    return {
      repositoryFullName: project?.path_with_namespace ? String(project.path_with_namespace) : null,
      providerRepoId: project?.id != null ? String(project.id) : null,
      kind: 'issue',
      externalId: attrs?.iid != null ? String(attrs.iid) : null,
      labels,
      action: attrs?.action || null,
    }
  }

  if (kindRaw === 'merge_request') {
    return {
      repositoryFullName: project?.path_with_namespace ? String(project.path_with_namespace) : null,
      providerRepoId: project?.id != null ? String(project.id) : null,
      kind: 'merge_request',
      externalId: attrs?.iid != null ? String(attrs.iid) : null,
      labels,
      action: attrs?.action || null,
    }
  }

  return {
    repositoryFullName: project?.path_with_namespace ? String(project.path_with_namespace) : null,
    providerRepoId: project?.id != null ? String(project.id) : null,
    kind: 'ignored',
    externalId: null,
    labels,
    action: attrs?.action || null,
  }
}

async function getConnectionWebhookSecret(connectionId: string): Promise<{
  secret: string
  row: typeof forgeConnections.$inferSelect
}> {
  const db = getDb()
  const [row] = await db.select().from(forgeConnections).where(eq(forgeConnections.id, connectionId)).limit(1)
  if (!row) throw new AppError(404, 'Connection not found', 'not_found')
  if (!row.webhookSecretCiphertext) {
    throw new AppError(401, 'Webhook secret not configured for this connection', 'webhook_not_configured')
  }
  try {
    return { secret: decryptSecret(row.webhookSecretCiphertext, encryptionKey()), row }
  } catch {
    throw new AppError(401, 'Webhook secret cannot be decrypted', 'webhook_secret_invalid')
  }
}

export async function ensureConnectionWebhookSecret(connectionId: string): Promise<string> {
  const db = getDb()
  const [row] = await db.select().from(forgeConnections).where(eq(forgeConnections.id, connectionId)).limit(1)
  if (!row) throw new AppError(404, 'Connection not found', 'not_found')
  if (row.webhookSecretCiphertext) {
    return decryptSecret(row.webhookSecretCiphertext, encryptionKey())
  }
  const secret = randomBytes(32).toString('hex')
  await db.update(forgeConnections).set({
    webhookSecretCiphertext: encryptSecret(secret, encryptionKey()),
    updatedAt: new Date(),
  }).where(eq(forgeConnections.id, connectionId))
  return secret
}

function shouldWakeFromGitHub(parsed: ReturnType<typeof parseGitHubWebhookEvent>): boolean {
  if (parsed.kind === 'ping' || parsed.kind === 'ignored') return false
  if (parsed.action !== 'labeled') return false
  return hasTriggerLabel(parsed.labels)
}

function shouldWakeFromGitLab(parsed: ReturnType<typeof parseGitLabWebhookEvent>): boolean {
  if (parsed.kind === 'ignored') return false
  return hasTriggerLabel(parsed.labels)
}

export async function handleGitHubWebhook(opts: {
  connectionId: string
  eventName: string | undefined
  signature: string | undefined
  rawBody: Buffer | string
  payload: Record<string, unknown>
}): Promise<WebhookWorkHint> {
  const { secret } = await getConnectionWebhookSecret(opts.connectionId)
  if (!verifyGitHubSignature(opts.rawBody, opts.signature, secret)) {
    throw new AppError(401, 'Invalid GitHub webhook signature', 'webhook_unauthorized')
  }

  const parsed = parseGitHubWebhookEvent(opts.eventName, opts.payload)
  const shouldWake = shouldWakeFromGitHub(parsed)
  if (shouldWake) {
    await wakeWorkerPoll('github.label', {
      connectionId: opts.connectionId,
      repositoryFullName: parsed.repositoryFullName,
      kind: parsed.kind,
      externalId: parsed.externalId,
      labels: parsed.labels,
    })
  }

  return {
    provider: 'github',
    connectionId: opts.connectionId,
    ...parsed,
    wokeWorker: shouldWake,
  }
}

export async function handleGitLabWebhook(opts: {
  connectionId: string
  tokenHeader: string | undefined
  payload: Record<string, unknown>
}): Promise<WebhookWorkHint> {
  const { secret } = await getConnectionWebhookSecret(opts.connectionId)
  if (!verifyGitLabToken(opts.tokenHeader, secret)) {
    throw new AppError(401, 'Invalid GitLab webhook token', 'webhook_unauthorized')
  }

  const parsed = parseGitLabWebhookEvent(opts.payload)
  const shouldWake = shouldWakeFromGitLab(parsed)
  if (shouldWake) {
    await wakeWorkerPoll('gitlab.label', {
      connectionId: opts.connectionId,
      repositoryFullName: parsed.repositoryFullName,
      kind: parsed.kind,
      externalId: parsed.externalId,
      labels: parsed.labels,
    })
  }

  return {
    provider: 'gitlab',
    connectionId: opts.connectionId,
    ...parsed,
    wokeWorker: shouldWake,
  }
}

function projectRefForRepo(repo: typeof repositories.$inferSelect): string | null {
  return repo.canonicalProjectIdentifier
    || (repo.remoteUrl
      ? repo.remoteUrl
        .replace(/\.git$/, '')
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^git@[^:]+:/, '')
      : null)
    || null
}

export async function setupWebhooksForConnection(
  connectionId: string,
  actor: { id: string, username: string },
  ipHash?: string,
): Promise<{
  callbackUrl: string
  attempted: number
  created: number
  updated: number
  failed: number
  errors: Array<{ repositoryId: string, name: string, message: string }>
}> {
  const secret = await ensureConnectionWebhookSecret(connectionId)
  const { token, row: connection } = await getConnectionAccessToken(connectionId)
  const callbackUrl = webhookCallbackUrl(connection.provider, connectionId)
  const db = getDb()

  const repos = await db.select().from(repositories).where(and(
    eq(repositories.connectionId, connectionId),
    eq(repositories.isArchived, false),
  ))

  let created = 0
  let updated = 0
  let failed = 0
  const errors: Array<{ repositoryId: string, name: string, message: string }> = []

  for (const repo of repos) {
    const projectRef = projectRefForRepo(repo)
    if (!projectRef) {
      failed += 1
      errors.push({ repositoryId: repo.id, name: repo.name, message: 'Missing project identifier' })
      continue
    }

    try {
      const result = connection.provider === 'github'
        ? await ensureGitHubRepoWebhook({
          token,
          fullName: projectRef,
          callbackUrl,
          secret,
        })
        : await ensureGitLabProjectWebhook({
          instanceUrl: connection.instanceUrl,
          token,
          projectPath: projectRef,
          callbackUrl,
          secret,
        })

      if (result.created) created += 1
      if (result.updated) updated += 1

      const settings = {
        ...(repo.settings || {}),
        webhook: {
          id: result.hookId,
          url: callbackUrl,
          installedAt: new Date().toISOString(),
        },
      }
      await db.update(repositories).set({
        settings,
        updatedAt: new Date(),
      }).where(eq(repositories.id, repo.id))
    } catch (err) {
      failed += 1
      errors.push({
        repositoryId: repo.id,
        name: repo.name,
        message: redactSecrets(err instanceof Error ? err.message : 'webhook setup failed').slice(0, 300),
      })
    }
  }

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.setup_webhooks',
    targetType: 'forge_connection',
    targetId: connectionId,
    metadata: {
      attempted: repos.length,
      created,
      updated,
      failed,
      callbackUrl,
    },
    ipHash,
  })

  return {
    callbackUrl,
    attempted: repos.length,
    created,
    updated,
    failed,
    errors: errors.slice(0, 20),
  }
}

export async function setupWebhookForRepository(
  repositoryId: string,
  actor: { id: string, username: string },
  ipHash?: string,
): Promise<{
  callbackUrl: string
  hookId: number
  created: boolean
  updated: boolean
}> {
  const db = getDb()
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1)
  if (!repo || repo.isArchived) throw new AppError(404, 'Repository not found', 'not_found')
  if (!repo.connectionId) {
    throw new AppError(400, 'Repository is not linked to a forge connection', 'missing_connection')
  }

  const projectRef = projectRefForRepo(repo)
  if (!projectRef) throw new AppError(400, 'Repository has no project identifier', 'missing_project_ref')

  const secret = await ensureConnectionWebhookSecret(repo.connectionId)
  const { token, row: connection } = await getConnectionAccessToken(repo.connectionId)
  const callbackUrl = webhookCallbackUrl(connection.provider, repo.connectionId)

  const result = connection.provider === 'github'
    ? await ensureGitHubRepoWebhook({
      token,
      fullName: projectRef,
      callbackUrl,
      secret,
    })
    : await ensureGitLabProjectWebhook({
      instanceUrl: connection.instanceUrl,
      token,
      projectPath: projectRef,
      callbackUrl,
      secret,
    })

  const settings = {
    ...(repo.settings || {}),
    webhook: {
      id: result.hookId,
      url: callbackUrl,
      installedAt: new Date().toISOString(),
    },
  }
  await db.update(repositories).set({
    settings,
    updatedAt: new Date(),
  }).where(eq(repositories.id, repo.id))

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'repository.setup_webhook',
    targetType: 'repository',
    targetId: repositoryId,
    metadata: {
      hookId: result.hookId,
      created: result.created,
      updated: result.updated,
      callbackUrl,
    },
    ipHash,
  })

  return {
    callbackUrl,
    hookId: result.hookId,
    created: result.created,
    updated: result.updated,
  }
}
