import { AppError } from '#utils/errors'
import { safeFetch } from '#utils/safe-fetch'
import { redactSecrets } from '#utils/redact'
import { codeChallengeS256 } from './pkce'
import type { ForgeAccount, ForgeRepo, TokenBundle } from './forge-types'

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token'
const GITHUB_API = 'https://api.github.com'
export const GITHUB_INSTANCE_URL = 'https://github.com'

/** Scopes needed for listing repos and existing worker operations (issues, PRs, push via HTTPS). */
export const GITHUB_OAUTH_SCOPES = ['repo', 'read:user', 'user:email'].join(' ')

export function githubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET)
}

export function buildGitHubAuthorizeUrl(opts: {
  state: string
  codeVerifier: string
  redirectUri: string
}): string {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID
  if (!clientId) throw new AppError(503, 'GitHub OAuth is not configured', 'oauth_not_configured')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: GITHUB_OAUTH_SCOPES,
    state: opts.state,
    code_challenge: codeChallengeS256(opts.codeVerifier),
    code_challenge_method: 'S256',
    allow_signup: 'false',
  })
  return `${GITHUB_AUTHORIZE}?${params.toString()}`
}

export async function exchangeGitHubCode(opts: {
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<TokenBundle> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new AppError(503, 'GitHub OAuth is not configured', 'oauth_not_configured')
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  })

  const res = await safeFetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    timeoutMs: 20000,
    expectedOrigin: 'https://github.com',
  })

  const data = await res.json() as Record<string, unknown>
  if (!res.ok || data.error || !data.access_token) {
    throw new AppError(
      400,
      redactSecrets(String(data.error_description || data.error || 'GitHub token exchange failed')),
      'oauth_exchange_failed',
    )
  }

  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000)
      : null,
    scopes: data.scope ? String(data.scope) : GITHUB_OAUTH_SCOPES,
  }
}

async function githubApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`
  const res = await safeFetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-worker-platform',
      ...(init?.headers || {}),
    },
    timeoutMs: 30000,
    expectedOrigin: 'https://api.github.com',
  })

  if (res.status === 401) {
    throw new AppError(401, 'GitHub credentials are invalid or revoked', 'forge_unauthorized')
  }
  if (res.status === 403) {
    throw new AppError(403, 'GitHub credentials lack required permissions', 'forge_forbidden')
  }
  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(502, `GitHub API error (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
  }
  return res.json() as Promise<T>
}

export async function fetchGitHubAccount(token: string): Promise<ForgeAccount> {
  const user = await githubApi<{ id: number, login: string, name: string | null }>(
    '/user',
    token,
  )
  return {
    accountId: String(user.id),
    accountLogin: user.login,
    accountName: user.name,
    scopes: GITHUB_OAUTH_SCOPES,
  }
}

export async function listGitHubRepositories(token: string): Promise<ForgeRepo[]> {
  const repos: ForgeRepo[] = []
  let page = 1
  const perPage = 100

  while (page <= 50) {
    const batch = await githubApi<Array<{
      id: number
      full_name: string
      owner?: { login?: string }
      name: string
      description?: string | null
      private?: boolean
      default_branch?: string
      clone_url?: string
      html_url?: string
      permissions?: { admin?: boolean, push?: boolean, pull?: boolean }
      archived?: boolean
      fork?: boolean
    }>>(
      `/user/repos?per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member&sort=full_name`,
      token,
    )
    if (!batch.length) break

    for (const r of batch) {
      repos.push({
        providerRepoId: String(r.id),
        fullName: String(r.full_name),
        ownerLogin: String(r.owner?.login || ''),
        name: String(r.name),
        description: r.description ? String(r.description) : null,
        visibility: r.private ? 'private' : 'public',
        defaultBranch: String(r.default_branch || 'main'),
        cloneUrlHttps: String(r.clone_url || `https://github.com/${r.full_name}.git`),
        htmlUrl: r.html_url ? String(r.html_url) : null,
        permissions: {
          admin: Boolean(r.permissions?.admin),
          push: Boolean(r.permissions?.push),
          pull: Boolean(r.permissions?.pull),
        },
        isArchived: Boolean(r.archived),
        isFork: Boolean(r.fork),
      })
    }

    if (batch.length < perPage) break
    page += 1
  }

  return repos
}

export async function revokeGitHubToken(token: string): Promise<void> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  try {
    await safeFetch(`${GITHUB_API}/applications/${clientId}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${basic}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-worker-platform',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: token }),
      timeoutMs: 15000,
      expectedOrigin: 'https://api.github.com',
    })
  } catch {
    // Best-effort revoke
  }
}

export async function testGitHubToken(token: string): Promise<{ ok: boolean, message: string, account?: ForgeAccount }> {
  try {
    const account = await fetchGitHubAccount(token)
    return { ok: true, message: `Authenticated as ${account.accountLogin}`, account }
  } catch (err) {
    return {
      ok: false,
      message: redactSecrets(err instanceof Error ? err.message : 'GitHub validation failed'),
    }
  }
}
