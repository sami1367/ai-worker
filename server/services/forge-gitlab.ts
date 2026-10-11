import { AppError } from '#utils/errors'
import { normalizeInstanceUrl, safeFetch } from '#utils/safe-fetch'
import { redactSecrets } from '#utils/redact'
import { codeChallengeS256 } from './pkce'
import type { ForgeAccount, ForgeRepo, TokenBundle } from './forge-types'

/** api scope covers project listing and worker label/MR/issue operations. */
export const GITLAB_OAUTH_SCOPES = 'api read_user read_repository write_repository'

export function gitlabOAuthConfigured(): boolean {
  return Boolean(process.env.GITLAB_OAUTH_CLIENT_ID && process.env.GITLAB_OAUTH_CLIENT_SECRET)
}

export function normalizeGitLabInstanceUrl(raw?: string | null): string {
  return normalizeInstanceUrl(raw || 'https://gitlab.com')
}

export function buildGitLabAuthorizeUrl(opts: {
  instanceUrl: string
  state: string
  codeVerifier: string
  redirectUri: string
}): string {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID
  if (!clientId) throw new AppError(503, 'GitLab OAuth is not configured', 'oauth_not_configured')

  const base = normalizeGitLabInstanceUrl(opts.instanceUrl)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GITLAB_OAUTH_SCOPES,
    state: opts.state,
    code_challenge: codeChallengeS256(opts.codeVerifier),
    code_challenge_method: 'S256',
  })
  return `${base}/oauth/authorize?${params.toString()}`
}

export async function exchangeGitLabCode(opts: {
  instanceUrl: string
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<TokenBundle> {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID
  const clientSecret = process.env.GITLAB_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new AppError(503, 'GitLab OAuth is not configured', 'oauth_not_configured')
  }

  const base = normalizeGitLabInstanceUrl(opts.instanceUrl)
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: opts.code,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  })

  const res = await safeFetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    timeoutMs: 20000,
    expectedOrigin: base,
  })

  const data = await res.json() as Record<string, unknown>
  if (!res.ok || data.error || !data.access_token) {
    throw new AppError(
      400,
      redactSecrets(String(data.error_description || data.error || 'GitLab token exchange failed')),
      'oauth_exchange_failed',
    )
  }

  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000)
      : null,
    scopes: data.scope ? String(data.scope) : GITLAB_OAUTH_SCOPES,
  }
}

export async function refreshGitLabToken(opts: {
  instanceUrl: string
  refreshToken: string
}): Promise<TokenBundle> {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID
  const clientSecret = process.env.GITLAB_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new AppError(503, 'GitLab OAuth is not configured', 'oauth_not_configured')
  }

  const base = normalizeGitLabInstanceUrl(opts.instanceUrl)
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: 'refresh_token',
  })

  const res = await safeFetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    timeoutMs: 20000,
    expectedOrigin: base,
  })

  const data = await res.json() as Record<string, unknown>
  if (!res.ok || !data.access_token) {
    throw new AppError(401, 'GitLab token refresh failed; reconnect required', 'oauth_refresh_failed')
  }

  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : opts.refreshToken,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000)
      : null,
    scopes: data.scope ? String(data.scope) : null,
  }
}

async function gitlabApi<T>(
  instanceUrl: string,
  path: string,
  token: string,
  init?: RequestInit,
): Promise<{ data: T, headers: Headers }> {
  const base = normalizeGitLabInstanceUrl(instanceUrl)
  const url = path.startsWith('http') ? path : `${base}/api/v4${path}`
  const res = await safeFetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ai-worker-platform',
      ...(init?.headers || {}),
    },
    timeoutMs: 30000,
    expectedOrigin: base,
  })

  if (res.status === 401) {
    throw new AppError(401, 'GitLab credentials are invalid or revoked', 'forge_unauthorized')
  }
  if (res.status === 403) {
    throw new AppError(403, 'GitLab credentials lack required permissions', 'forge_forbidden')
  }
  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(502, `GitLab API error (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
  }
  return { data: await res.json() as T, headers: res.headers }
}

export const GITLAB_PRIVATE_ACCESS_HINT
  = 'Token cannot list private projects. Use a personal access token with the "api" scope '
  + '(or at least "read_api"). "read_repository" alone is not enough to discover private projects.'

async function fetchGitLabTokenScopes(instanceUrl: string, token: string): Promise<string[] | null> {
  try {
    const { data } = await gitlabApi<{ scopes?: string[] }>(
      instanceUrl,
      '/personal_access_tokens/self',
      token,
    )
    return Array.isArray(data.scopes) ? data.scopes.map(String) : null
  } catch {
    // OAuth tokens and older GitLab versions may not support this endpoint.
    return null
  }
}

export function gitlabTokenCanAccessPrivate(scopes: string[] | null): boolean | null {
  if (!scopes) return null
  if (scopes.includes('api') || scopes.includes('read_api')) return true
  return false
}

export async function fetchGitLabAccount(instanceUrl: string, token: string): Promise<ForgeAccount> {
  const { data } = await gitlabApi<{ id: number, username: string, name: string | null }>(
    instanceUrl,
    '/user',
    token,
  )
  const scopes = await fetchGitLabTokenScopes(instanceUrl, token)
  return {
    accountId: String(data.id),
    accountLogin: data.username,
    accountName: data.name,
    scopes: scopes?.length ? scopes.join(' ') : null,
  }
}

export async function listGitLabProjects(instanceUrl: string, token: string): Promise<ForgeRepo[]> {
  const repos: ForgeRepo[] = []
  let page = 1
  const perPage = 100

  while (page <= 50) {
    // membership=true returns projects the token can access (incl. private).
    // Do not set visibility= — omitting it returns public + internal + private.
    const { data: batch, headers } = await gitlabApi<Array<{
      id: number
      path_with_namespace?: string
      path?: string
      name?: string
      namespace?: { full_path?: string, path?: string }
      description?: string | null
      visibility?: string
      default_branch?: string
      http_url_to_repo?: string
      web_url?: string
      permissions?: {
        project_access?: { access_level?: number }
        group_access?: { access_level?: number }
      }
      archived?: boolean
      forked_from_project?: unknown
    }>>(
      instanceUrl,
      `/projects?membership=true&with_shared=true&simple=false`
      + `&per_page=${perPage}&page=${page}&order_by=path&sort=asc`,
      token,
    )
    if (!batch.length) break

    for (const p of batch) {
      const pathWithNamespace = String(p.path_with_namespace || p.path)
      const namespace = String(p.namespace?.full_path || p.namespace?.path || pathWithNamespace.split('/')[0] || '')
      repos.push({
        providerRepoId: String(p.id),
        fullName: pathWithNamespace,
        ownerLogin: namespace,
        name: String(p.path || p.name),
        description: p.description ? String(p.description) : null,
        visibility: String(p.visibility || 'private'),
        defaultBranch: String(p.default_branch || 'main'),
        cloneUrlHttps: String(p.http_url_to_repo || `${normalizeGitLabInstanceUrl(instanceUrl)}/${pathWithNamespace}.git`),
        htmlUrl: p.web_url ? String(p.web_url) : null,
        permissions: {
          accessLevel: p.permissions?.project_access?.access_level
            ?? p.permissions?.group_access?.access_level
            ?? null,
        },
        isArchived: Boolean(p.archived),
        isFork: Boolean(p.forked_from_project),
      })
    }

    const nextPage = headers.get('x-next-page')
    if (!nextPage) break
    page = Number(nextPage) || page + 1
    if (batch.length < perPage) break
  }

  return repos
}

export async function revokeGitLabToken(instanceUrl: string, token: string): Promise<void> {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID
  const clientSecret = process.env.GITLAB_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return

  const base = normalizeGitLabInstanceUrl(instanceUrl)
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
    })
    await safeFetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: 15000,
      expectedOrigin: base,
    })
  } catch {
    // Best-effort
  }
}

export async function testGitLabToken(
  instanceUrl: string,
  token: string,
): Promise<{
  ok: boolean
  message: string
  account?: ForgeAccount
  canAccessPrivate?: boolean | null
  oauthScopes?: string[]
}> {
  try {
    const account = await fetchGitLabAccount(instanceUrl, token)
    const oauthScopes = account.scopes
      ? account.scopes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      : []
    const canAccessPrivate = gitlabTokenCanAccessPrivate(oauthScopes.length ? oauthScopes : null)

    if (canAccessPrivate === false) {
      return {
        ok: false,
        message: GITLAB_PRIVATE_ACCESS_HINT,
        account,
        canAccessPrivate: false,
        oauthScopes,
      }
    }

    return {
      ok: true,
      message: `Authenticated as ${account.accountLogin}`,
      account,
      canAccessPrivate,
      oauthScopes,
    }
  } catch (err) {
    return {
      ok: false,
      message: redactSecrets(err instanceof Error ? err.message : 'GitLab validation failed'),
    }
  }
}
