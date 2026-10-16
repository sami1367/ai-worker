import { rm } from 'node:fs/promises'
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { forgeConnections, oauthStates, repositories } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { decryptSecret, encryptSecret } from '#utils/crypto'
import { managedWorkspacePath } from '#utils/paths'
import { redactSecrets } from '#utils/redact'
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchGitHubAccount,
  GITHUB_FINE_GRAINED_NO_PRIVATE_HINT,
  GITHUB_INSTANCE_URL,
  githubOAuthConfigured,
  revokeGitHubToken,
  testGitHubToken,
} from './forge-github'
import {
  buildGitLabAuthorizeUrl,
  exchangeGitLabCode,
  fetchGitLabAccount,
  gitlabOAuthConfigured,
  normalizeGitLabInstanceUrl,
  refreshGitLabToken,
  revokeGitLabToken,
  testGitLabToken,
} from './forge-gitlab'
import { newCodeVerifier, newOAuthState } from './pkce'
import { writeAudit } from './audit'
import { exportForgeCredentialsAndWake, exportForgeCredentialsForWorker } from './forge-credentials'

function encryptionKey(): string {
  const key = process.env.SECRET_ENCRYPTION_KEY || ''
  if (!key) throw new AppError(500, 'SECRET_ENCRYPTION_KEY is not configured', 'misconfigured')
  return key
}

function encryptToken(token: string): string {
  return encryptSecret(token, encryptionKey())
}

function decryptToken(ciphertext: string | null | undefined): string {
  if (!ciphertext) throw new AppError(400, 'Connection has no stored credentials; reconnect required', 'missing_credentials')
  try {
    return decryptSecret(ciphertext, encryptionKey())
  } catch {
    throw new AppError(400, 'Stored credentials cannot be decrypted; reconnect required', 'decrypt_failed')
  }
}

/** Paused connections keep credentials but are excluded from fetch/list/export. */
export function isConnectionPaused(status: string): boolean {
  return status === 'disconnected'
}

/** Whether a managed repo should appear / be polled for its forge connection. */
export function shouldExposeRepositoryForConnection(
  connectionId: string | null | undefined,
  pausedConnectionIds: ReadonlySet<string>,
): boolean {
  if (!connectionId) return true
  return !pausedConnectionIds.has(connectionId)
}

export function publicConnection(row: typeof forgeConnections.$inferSelect) {
  const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.displayName,
    instanceUrl: row.instanceUrl,
    accountId: row.accountId,
    accountLogin: row.accountLogin,
    accountName: row.accountName,
    scopes: row.scopes,
    status: row.status,
    /** True when connection is disabled but credentials are retained for re-enable. */
    disabled: isConnectionPaused(row.status),
    lastError: row.lastError ? redactSecrets(row.lastError) : null,
    lastSyncAt: row.lastSyncAt,
    lastValidatedAt: row.lastValidatedAt,
    tokenExpiresAt: row.tokenExpiresAt,
    hasAccessToken: Boolean(row.accessTokenCiphertext),
    hasRefreshToken: Boolean(row.refreshTokenCiphertext),
    hasWebhookSecret: Boolean(row.webhookSecretCiphertext),
    webhookUrl: `${base}/api/v1/webhooks/${row.provider}/${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listPausedConnectionIds(): Promise<string[]> {
  const db = getDb()
  const rows = await db.select({ id: forgeConnections.id }).from(forgeConnections)
    .where(eq(forgeConnections.status, 'disconnected'))
  return rows.map((r) => r.id)
}

export async function listConnections() {
  const db = getDb()
  const rows = await db.select().from(forgeConnections).orderBy(desc(forgeConnections.updatedAt))
  return { items: rows.map(publicConnection) }
}

export async function getConnection(id: string) {
  const db = getDb()
  const [row] = await db.select().from(forgeConnections).where(eq(forgeConnections.id, id)).limit(1)
  if (!row) throw new AppError(404, 'Connection not found', 'not_found')
  return { row, public: publicConnection(row) }
}

export async function getConnectionAccessToken(id: string): Promise<{
  token: string
  row: typeof forgeConnections.$inferSelect
}> {
  const { row } = await getConnection(id)
  if (row.status === 'disconnected') {
    throw new AppError(400, 'Connection is disconnected', 'disconnected')
  }

  let token = decryptToken(row.accessTokenCiphertext)

  // Refresh GitLab tokens near expiry when a refresh token exists
  if (
    row.provider === 'gitlab'
    && row.refreshTokenCiphertext
    && row.tokenExpiresAt
    && row.tokenExpiresAt.getTime() < Date.now() + 60_000
  ) {
    try {
      const refresh = decryptToken(row.refreshTokenCiphertext)
      const bundle = await refreshGitLabToken({
        instanceUrl: row.instanceUrl,
        refreshToken: refresh,
      })
      const db = getDb()
      const [updated] = await db.update(forgeConnections).set({
        accessTokenCiphertext: encryptToken(bundle.accessToken),
        refreshTokenCiphertext: bundle.refreshToken
          ? encryptToken(bundle.refreshToken)
          : row.refreshTokenCiphertext,
        tokenExpiresAt: bundle.expiresAt ?? null,
        scopes: bundle.scopes ?? row.scopes,
        status: 'active',
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(forgeConnections.id, id)).returning()
      token = bundle.accessToken
      await exportForgeCredentialsAndWake('forge.token_refresh')
      return { token, row: updated }
    } catch (err) {
      const db = getDb()
      await db.update(forgeConnections).set({
        status: 'expired',
        lastError: redactSecrets(err instanceof Error ? err.message : 'Token refresh failed'),
        updatedAt: new Date(),
      }).where(eq(forgeConnections.id, id))
      throw new AppError(401, 'Connection token expired; reconnect required', 'expired')
    }
  }

  return { token, row }
}

/**
 * Ensure forge account id/login are stored. Fetches /user when missing
 * (connect normally stores them; this covers older rows or partial data).
 */
export async function ensureConnectionAccount(connectionId: string): Promise<{
  token: string
  row: typeof forgeConnections.$inferSelect
}> {
  const { token, row } = await getConnectionAccessToken(connectionId)
  if (row.accountId && row.accountLogin) {
    return { token, row }
  }

  const account = row.provider === 'github'
    ? await fetchGitHubAccount(token)
    : await fetchGitLabAccount(row.instanceUrl, token)

  const db = getDb()
  const [updated] = await db.update(forgeConnections).set({
    accountId: account.accountId,
    accountLogin: account.accountLogin,
    accountName: account.accountName,
    scopes: account.scopes ?? row.scopes,
    lastValidatedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(forgeConnections.id, connectionId)).returning()

  return { token, row: updated }
}

export const startGitHubConnectionSchema = z.object({
  displayName: z.string().max(128).optional(),
  redirectPath: z.string().max(512).optional(),
})

export const startGitLabConnectionSchema = z.object({
  instanceUrl: z.string().max(512).default('https://gitlab.com'),
  displayName: z.string().max(128).optional(),
  redirectPath: z.string().max(512).optional(),
})

export const githubTokenConnectionSchema = z.object({
  token: z.string().min(8).max(512),
  displayName: z.string().max(128).optional(),
  /** When true (default), newly registered repos from this connect are enabled. */
  enableRepositories: z.boolean().default(true),
})

export const gitlabTokenConnectionSchema = z.object({
  instanceUrl: z.string().max(512).default('https://gitlab.com'),
  token: z.string().min(8).max(512),
  displayName: z.string().max(128).optional(),
  /** When true (default), newly registered repos from this connect are enabled. */
  enableRepositories: z.boolean().default(true),
})

async function upsertActiveConnection(opts: {
  provider: 'github' | 'gitlab'
  instanceUrl: string
  account: { accountId: string, accountLogin: string, accountName: string | null, scopes: string | null }
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  scopes?: string | null
  displayName?: string | null
  createdBy: string
  actorUsername?: string
  enableRepositories?: boolean
}) {
  const db = getDb()
  const [existing] = await db.select().from(forgeConnections).where(and(
    eq(forgeConnections.provider, opts.provider),
    eq(forgeConnections.instanceUrl, opts.instanceUrl),
    eq(forgeConnections.accountId, opts.account.accountId),
  )).limit(1)

  let connection
  if (existing) {
    ;[connection] = await db.update(forgeConnections).set({
      displayName: opts.displayName ?? existing.displayName,
      accountLogin: opts.account.accountLogin,
      accountName: opts.account.accountName,
      scopes: opts.scopes ?? opts.account.scopes,
      accessTokenCiphertext: encryptToken(opts.accessToken),
      refreshTokenCiphertext: opts.refreshToken
        ? encryptToken(opts.refreshToken)
        : existing.refreshTokenCiphertext,
      tokenExpiresAt: opts.expiresAt ?? null,
      status: 'active',
      lastError: null,
      lastValidatedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(forgeConnections.id, existing.id)).returning()
  } else {
    ;[connection] = await db.insert(forgeConnections).values({
      provider: opts.provider,
      displayName: opts.displayName
        || `${opts.provider === 'github' ? 'GitHub' : 'GitLab'} (${opts.account.accountLogin})`,
      instanceUrl: opts.instanceUrl,
      accountId: opts.account.accountId,
      accountLogin: opts.account.accountLogin,
      accountName: opts.account.accountName,
      scopes: opts.scopes ?? opts.account.scopes,
      accessTokenCiphertext: encryptToken(opts.accessToken),
      refreshTokenCiphertext: opts.refreshToken ? encryptToken(opts.refreshToken) : null,
      tokenExpiresAt: opts.expiresAt ?? null,
      status: 'active',
      lastValidatedAt: new Date(),
      createdBy: opts.createdBy,
    }).returning()
  }

  await writeAudit({
    actorUserId: opts.createdBy,
    actorUsername: opts.actorUsername,
    action: existing ? 'connection.reconnect' : 'connection.create',
    targetType: 'forge_connection',
    targetId: connection.id,
    metadata: {
      provider: opts.provider,
      accountLogin: opts.account.accountLogin,
      instanceUrl: opts.instanceUrl,
      auth: opts.scopes?.includes('personal_access_token') ? 'token' : 'oauth',
    },
  })

  try {
    const { syncConnectionRepositories } = await import('./discovery')
    await syncConnectionRepositories(connection.id, {
      actorUserId: opts.createdBy,
      actorUsername: opts.actorUsername,
      enableRepositories: opts.enableRepositories,
    })
  } catch (err) {
    await db.update(forgeConnections).set({
      status: 'error',
      lastError: redactSecrets(err instanceof Error ? err.message : 'Discovery failed'),
      updatedAt: new Date(),
    }).where(eq(forgeConnections.id, connection.id))
  }

  await exportForgeCredentialsAndWake('forge.connect')
  const [fresh] = await db.select().from(forgeConnections).where(eq(forgeConnections.id, connection.id)).limit(1)
  return publicConnection(fresh || connection)
}

export async function connectGitHubWithToken(
  input: z.infer<typeof githubTokenConnectionSchema>,
  actor: { id: string, username: string },
) {
  const parsed = githubTokenConnectionSchema.parse(input)
  const token = parsed.token.trim()
  const result = await testGitHubToken(token)
  if (!result.ok || !result.account) {
    throw new AppError(400, result.message || 'GitHub token is invalid', 'invalid_token')
  }

  const kind = token.startsWith('github_pat_') ? 'fine-grained' : 'classic'
  const scopeLabel = result.oauthScopes?.length
    ? `personal_access_token ${kind} ${result.oauthScopes.join(' ')}`
    : `personal_access_token ${kind}`
  const connection = await upsertActiveConnection({
    provider: 'github',
    instanceUrl: GITHUB_INSTANCE_URL,
    account: {
      ...result.account,
      scopes: result.account.scopes || scopeLabel,
    },
    accessToken: token,
    scopes: scopeLabel,
    displayName: parsed.displayName,
    createdBy: actor.id,
    actorUsername: actor.username,
    enableRepositories: parsed.enableRepositories,
  })

  // Surface fine-grained private-access gaps immediately after first sync.
  if (result.canAccessPrivate === false && kind === 'fine-grained') {
    const db = getDb()
    await db.update(forgeConnections).set({
      lastError: GITHUB_FINE_GRAINED_NO_PRIVATE_HINT,
      updatedAt: new Date(),
    }).where(eq(forgeConnections.id, connection.id))
    const [fresh] = await db.select().from(forgeConnections).where(eq(forgeConnections.id, connection.id)).limit(1)
    return publicConnection(fresh || connection)
  }

  return connection
}

export async function connectGitLabWithToken(
  input: z.infer<typeof gitlabTokenConnectionSchema>,
  actor: { id: string, username: string },
) {
  const parsed = gitlabTokenConnectionSchema.parse(input)
  const instanceUrl = normalizeGitLabInstanceUrl(parsed.instanceUrl)
  const token = parsed.token.trim()
  const result = await testGitLabToken(instanceUrl, token)
  if (!result.ok || !result.account) {
    throw new AppError(400, result.message || 'GitLab token is invalid', 'invalid_token')
  }

  const scopeLabel = result.oauthScopes?.length
    ? `personal_access_token ${result.oauthScopes.join(' ')}`
    : 'personal_access_token'
  return upsertActiveConnection({
    provider: 'gitlab',
    instanceUrl,
    account: {
      ...result.account,
      scopes: result.account.scopes || scopeLabel,
    },
    accessToken: token,
    scopes: scopeLabel,
    displayName: parsed.displayName,
    createdBy: actor.id,
    actorUsername: actor.username,
    enableRepositories: parsed.enableRepositories,
  })
}

function oauthCallbackUrl(provider: 'github' | 'gitlab'): string {
  const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  return `${base}/api/v1/connections/oauth/${provider}/callback`
}

function safeRedirectPath(path?: string | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/connections'
  return path
}

async function purgeExpiredOAuthStates() {
  const db = getDb()
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()))
}

export async function startGitHubOAuth(
  input: z.infer<typeof startGitHubConnectionSchema>,
  actor: { id: string, username: string },
) {
  if (!githubOAuthConfigured()) {
    throw new AppError(503, 'GitHub OAuth client is not configured', 'oauth_not_configured')
  }
  const parsed = startGitHubConnectionSchema.parse(input)
  await purgeExpiredOAuthStates()

  const state = newOAuthState()
  const codeVerifier = newCodeVerifier()
  const db = getDb()
  await db.insert(oauthStates).values({
    state,
    provider: 'github',
    instanceUrl: GITHUB_INSTANCE_URL,
    codeVerifier,
    redirectPath: safeRedirectPath(parsed.redirectPath),
    createdBy: actor.id,
    displayName: parsed.displayName,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })

  const authorizeUrl = buildGitHubAuthorizeUrl({
    state,
    codeVerifier,
    redirectUri: oauthCallbackUrl('github'),
  })

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.oauth_start',
    targetType: 'forge_connection',
    metadata: { provider: 'github' },
  })

  return { authorizeUrl, state }
}

export async function startGitLabOAuth(
  input: z.infer<typeof startGitLabConnectionSchema>,
  actor: { id: string, username: string },
) {
  if (!gitlabOAuthConfigured()) {
    throw new AppError(503, 'GitLab OAuth client is not configured', 'oauth_not_configured')
  }
  const parsed = startGitLabConnectionSchema.parse(input)
  const instanceUrl = normalizeGitLabInstanceUrl(parsed.instanceUrl)
  await purgeExpiredOAuthStates()

  const state = newOAuthState()
  const codeVerifier = newCodeVerifier()
  const db = getDb()
  await db.insert(oauthStates).values({
    state,
    provider: 'gitlab',
    instanceUrl,
    codeVerifier,
    redirectPath: safeRedirectPath(parsed.redirectPath),
    createdBy: actor.id,
    displayName: parsed.displayName,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })

  const authorizeUrl = buildGitLabAuthorizeUrl({
    instanceUrl,
    state,
    codeVerifier,
    redirectUri: oauthCallbackUrl('gitlab'),
  })

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.oauth_start',
    targetType: 'forge_connection',
    metadata: { provider: 'gitlab', instanceUrl },
  })

  return { authorizeUrl, state }
}

export async function completeOAuthCallback(opts: {
  provider: 'github' | 'gitlab'
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
}) {
  if (opts.error) {
    throw new AppError(
      400,
      redactSecrets(opts.errorDescription || opts.error),
      'oauth_denied',
    )
  }
  if (!opts.code || !opts.state) {
    throw new AppError(400, 'Missing OAuth code or state', 'oauth_invalid')
  }

  const db = getDb()
  const [pending] = await db.select().from(oauthStates).where(eq(oauthStates.state, opts.state)).limit(1)
  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    if (pending) await db.delete(oauthStates).where(eq(oauthStates.state, opts.state))
    throw new AppError(400, 'OAuth state is invalid or expired', 'oauth_state_invalid')
  }
  if (pending.provider !== opts.provider) {
    throw new AppError(400, 'OAuth provider mismatch', 'oauth_state_invalid')
  }

  await db.delete(oauthStates).where(eq(oauthStates.state, opts.state))

  const redirectUri = oauthCallbackUrl(opts.provider)
  let bundle
  let account

  if (opts.provider === 'github') {
    bundle = await exchangeGitHubCode({
      code: opts.code,
      codeVerifier: pending.codeVerifier,
      redirectUri,
    })
    account = await fetchGitHubAccount(bundle.accessToken)
  } else {
    bundle = await exchangeGitLabCode({
      instanceUrl: pending.instanceUrl,
      code: opts.code,
      codeVerifier: pending.codeVerifier,
      redirectUri,
    })
    account = await fetchGitLabAccount(pending.instanceUrl, bundle.accessToken)
  }

  const connection = await upsertActiveConnection({
    provider: opts.provider,
    instanceUrl: pending.instanceUrl,
    account,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
    scopes: bundle.scopes ?? account.scopes,
    displayName: pending.displayName,
    createdBy: pending.createdBy,
  })

  return {
    connection,
    redirectPath: safeRedirectPath(pending.redirectPath),
  }
}

export async function testConnection(id: string, actor: { id: string, username: string }) {
  const { token, row } = await getConnectionAccessToken(id)
  const result = row.provider === 'github'
    ? await testGitHubToken(token)
    : await testGitLabToken(row.instanceUrl, token)

  const detectedScopes = result.oauthScopes?.length
    ? `${row.scopes?.includes('personal_access_token') ? 'personal_access_token ' : ''}${result.oauthScopes.join(' ')}`.trim()
    : result.account?.scopes || null

  const db = getDb()
  const [updated] = await db.update(forgeConnections).set({
    status: result.ok ? 'active' : 'error',
    lastError: result.ok ? null : redactSecrets(result.message),
    lastValidatedAt: result.ok ? new Date() : row.lastValidatedAt,
    accountId: result.account?.accountId ?? row.accountId,
    accountLogin: result.account?.accountLogin ?? row.accountLogin,
    accountName: result.account?.accountName ?? row.accountName,
    ...(detectedScopes ? { scopes: detectedScopes } : {}),
    updatedAt: new Date(),
  }).where(eq(forgeConnections.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.test',
    targetType: 'forge_connection',
    targetId: id,
    metadata: { ok: result.ok },
  })

  return { ...publicConnection(updated), test: result }
}

/**
 * Disable a connection without clearing credentials so it can be re-enabled.
 * Discovery, issue fetch, and the repositories page skip this connection's repos.
 */
export async function disconnectConnection(
  id: string,
  actor: { id: string, username: string },
) {
  const { row } = await getConnection(id)
  if (row.status === 'disconnected') {
    return publicConnection(row)
  }

  const db = getDb()
  const [updated] = await db.update(forgeConnections).set({
    status: 'disconnected',
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(forgeConnections.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.disable',
    targetType: 'forge_connection',
    targetId: id,
    metadata: {
      provider: row.provider,
      instanceUrl: row.instanceUrl,
      hasAccessToken: Boolean(row.accessTokenCiphertext),
    },
  })

  await exportForgeCredentialsAndWake('forge.disable')
  try {
    const { exportWorkerConfig } = await import('./config-sync')
    await exportWorkerConfig(actor)
  } catch {
    // best-effort: credentials wake already ran
  }
  return publicConnection(updated)
}

/** Re-enable a previously disabled connection using retained credentials. */
export async function enableConnection(
  id: string,
  actor: { id: string, username: string },
) {
  const { row } = await getConnection(id)
  if (row.status !== 'disconnected') {
    return publicConnection(row)
  }
  if (!row.accessTokenCiphertext) {
    throw new AppError(
      400,
      'Connection has no stored credentials; reconnect with a token',
      'missing_credentials',
    )
  }

  const db = getDb()
  const [updated] = await db.update(forgeConnections).set({
    status: 'active',
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(forgeConnections.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.enable',
    targetType: 'forge_connection',
    targetId: id,
    metadata: { provider: row.provider, instanceUrl: row.instanceUrl },
  })

  await exportForgeCredentialsAndWake('forge.enable')
  try {
    const { exportWorkerConfig } = await import('./config-sync')
    await exportWorkerConfig(actor)
  } catch {
    // best-effort
  }
  return publicConnection(updated)
}

/**
 * Permanently delete a connection, its discovered repos, and registered repositories
 * (including managed workspace directories on disk).
 */
export async function removeConnection(
  id: string,
  actor: { id: string, username: string },
) {
  const { row } = await getConnection(id)
  const db = getDb()

  const linkedRepos = await db.select().from(repositories).where(eq(repositories.connectionId, id))

  for (const repo of linkedRepos) {
    try {
      const managed = managedWorkspacePath(repo.workspaceId)
      if (!repo.localPath || repo.localPath === managed) {
        await rm(managed, { recursive: true, force: true })
      }
    } catch {
      // best-effort workspace cleanup
    }
  }

  let token: string | null
  try {
    token = row.accessTokenCiphertext ? decryptToken(row.accessTokenCiphertext) : null
  } catch {
    token = null
  }
  const isPat = Boolean(row.scopes?.includes('personal_access_token'))
  if (token && !isPat) {
    if (row.provider === 'github') await revokeGitHubToken(token)
    else await revokeGitLabToken(row.instanceUrl, token)
  }

  if (linkedRepos.length) {
    await db.delete(repositories).where(eq(repositories.connectionId, id))
  }
  await db.delete(forgeConnections).where(eq(forgeConnections.id, id))

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'connection.remove',
    targetType: 'forge_connection',
    targetId: id,
    metadata: {
      provider: row.provider,
      instanceUrl: row.instanceUrl,
      removedRepositories: linkedRepos.length,
    },
  })

  await exportForgeCredentialsAndWake('forge.remove')
  try {
    const { exportWorkerConfig } = await import('./config-sync')
    await exportWorkerConfig(actor)
  } catch {
    // best-effort
  }

  return {
    ok: true as const,
    id,
    removedRepositories: linkedRepos.length,
  }
}

export async function oauthStatus() {
  return {
    githubConfigured: githubOAuthConfigured(),
    gitlabConfigured: gitlabOAuthConfigured(),
    githubCallbackUrl: oauthCallbackUrl('github'),
    gitlabCallbackUrl: oauthCallbackUrl('gitlab'),
    githubScopes: 'repo read:user user:email',
    gitlabScopes: 'api read_user read_repository write_repository',
    // Token connect works without OAuth app setup (recommended for self-hosted)
    tokenConnectSupported: true,
    githubTokenHint: 'Classic PAT with full "repo" scope (public_repo alone only lists public repos). Fine-grained: All repositories (or selected private ones); for org private repos select the org as resource owner; Metadata + Contents/Issues/PRs.',
    gitlabTokenHint: 'Personal access token with api scope (read_api minimum to list private projects; api needed for worker ops)',
  }
}
