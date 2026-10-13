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

async function githubApiRaw(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<{ data: unknown, headers: Headers }> {
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
  return { data: await res.json(), headers: res.headers }
}

async function githubApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const { data } = await githubApiRaw(path, token, init)
  return data as T
}

function parseOAuthScopes(header: string | null): string[] {
  if (!header) return []
  return header.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Classic PATs expose X-OAuth-Scopes. Fine-grained PATs usually leave it empty. */
export function githubClassicTokenCanAccessPrivate(scopes: string[]): boolean | null {
  if (!scopes.length) return null
  if (scopes.includes('repo')) return true
  return false
}

export const GITHUB_PRIVATE_ACCESS_HINT
  = 'Token cannot access private repositories. Use a classic PAT with the full "repo" scope (not only public_repo), '
  + 'or a fine-grained PAT with Repository access covering those private repos (for org repos, create the token '
  + 'with that organization as the resource owner) and at least Metadata: Read.'

export const GITHUB_FINE_GRAINED_NO_PRIVATE_HINT
  = 'GitHub returned no private repositories for this fine-grained token. If you expected private repos: '
  + '(1) recreate as a classic PAT with the full "repo" scope (most reliable), or '
  + '(2) recreate the fine-grained PAT with Repository access = All repositories '
  + '(for organization private repos, create the token with that organization as the resource owner, not your user).'

function mapGitHubRepo(r: {
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
}): ForgeRepo {
  return {
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
  }
}

export async function fetchGitHubAccount(token: string): Promise<ForgeAccount> {
  const { data, headers } = await githubApiRaw('/user', token)
  const user = data as { id: number, login: string, name: string | null }
  const scopes = parseOAuthScopes(headers.get('x-oauth-scopes'))
  return {
    accountId: String(user.id),
    accountLogin: user.login,
    accountName: user.name,
    scopes: scopes.length ? scopes.join(', ') : null,
  }
}

export async function listGitHubRepositories(token: string): Promise<ForgeRepo[]> {
  const repos = new Map<string, ForgeRepo>()
  let page = 1
  const perPage = 100

  // visibility=all is required so classic/public_repo-limited tokens are not silently
  // treated as "all accessible repos" when affiliation is set.
  while (page <= 50) {
    const batch = await githubApi<Array<Parameters<typeof mapGitHubRepo>[0]>>(
      `/user/repos?per_page=${perPage}&page=${page}`
      + '&affiliation=owner,collaborator,organization_member'
      + '&visibility=all&sort=full_name',
      token,
    )
    if (!batch.length) break

    for (const r of batch) {
      const mapped = mapGitHubRepo(r)
      repos.set(mapped.providerRepoId, mapped)
    }

    if (batch.length < perPage) break
    page += 1
  }

  return [...repos.values()]
}

export type ForgeLabelSpec = {
  name: string
  color: string
  description: string
}

function githubHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-worker-platform',
    ...(extra || {}),
  }
}

function normalizeGitHubRepoFullName(fullName: string): string {
  const repo = fullName.replace(/\.git$/, '').replace(/^https?:\/\/github\.com\//, '')
  if (!repo.includes('/')) {
    throw new AppError(400, `Invalid GitHub repository: ${fullName}`, 'invalid_repo')
  }
  return repo
}

async function listGitHubLabelNames(token: string, repo: string): Promise<Set<string>> {
  const names = new Set<string>()
  let page = 1
  while (page <= 20) {
    const res = await safeFetch(
      `${GITHUB_API}/repos/${repo}/labels?per_page=100&page=${page}`,
      {
        headers: githubHeaders(token),
        timeoutMs: 30000,
        expectedOrigin: 'https://api.github.com',
      },
    )
    if (res.status === 401) {
      throw new AppError(401, 'GitHub credentials are invalid or revoked', 'forge_unauthorized')
    }
    if (res.status === 403) {
      throw new AppError(403, 'GitHub credentials lack permission to manage labels', 'forge_forbidden')
    }
    if (res.status === 404) {
      throw new AppError(404, `GitHub repository not found: ${repo}`, 'forge_not_found')
    }
    if (!res.ok) {
      const text = redactSecrets(await res.text())
      throw new AppError(502, `GitHub list labels failed (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
    }
    const batch = await res.json() as Array<{ name?: string }>
    for (const item of batch) {
      if (item.name) names.add(String(item.name).toLowerCase())
    }
    if (batch.length < 100) break
    page += 1
  }
  return names
}

export type ForgeLabeledItem = {
  externalId: string
  title: string
  url: string
  labels: string[]
  createdAt: string
  kind: 'issue' | 'pull_request'
}

const ISSUE_AI_LABELS = ['ai', 'ai-working', 'ai-failed', 'ai-pr'] as const
const PR_AI_LABELS = [
  'ai', 'ai-working', 'ai-failed', 'ai-pr',
  'ai-review', 'ai-reviewing', 'ai-reviewed', 'ai-review-failed',
] as const

function labelNames(labels: Array<{ name?: string } | string> | undefined): string[] {
  if (!Array.isArray(labels)) return []
  return labels
    .map((l) => (typeof l === 'string' ? l : l.name || ''))
    .filter(Boolean)
    .map(String)
}

function hasAnyLabel(labels: string[], wanted: readonly string[]): boolean {
  const set = new Set(labels.map((l) => l.toLowerCase()))
  return wanted.some((w) => set.has(w.toLowerCase()))
}

/** Open issues carrying any AI implement workflow label (excludes PRs). */
export async function listGitHubAiIssues(
  token: string,
  fullName: string,
): Promise<ForgeLabeledItem[]> {
  const repo = normalizeGitHubRepoFullName(fullName)
  const byId = new Map<string, ForgeLabeledItem>()

  for (const label of ISSUE_AI_LABELS) {
    let page = 1
    while (page <= 10) {
      const batch = await githubApi<Array<{
        number: number
        title?: string
        html_url?: string
        created_at?: string
        pull_request?: unknown
        labels?: Array<{ name?: string } | string>
      }>>(
        `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}&sort=created&direction=asc`,
        token,
      )
      if (!batch.length) break
      for (const issue of batch) {
        if (issue.pull_request) continue
        const labels = labelNames(issue.labels)
        if (!hasAnyLabel(labels, ISSUE_AI_LABELS)) continue
        const id = String(issue.number)
        byId.set(id, {
          externalId: id,
          title: String(issue.title || `#${issue.number}`),
          url: String(issue.html_url || `https://github.com/${repo}/issues/${issue.number}`),
          labels,
          createdAt: String(issue.created_at || new Date(0).toISOString()),
          kind: 'issue',
        })
      }
      if (batch.length < 100) break
      page += 1
    }
  }

  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Open PRs carrying any AI implement or review workflow label. */
export async function listGitHubAiPullRequests(
  token: string,
  fullName: string,
): Promise<ForgeLabeledItem[]> {
  const repo = normalizeGitHubRepoFullName(fullName)
  const byId = new Map<string, ForgeLabeledItem>()
  const labelQuery = PR_AI_LABELS.map((l) => `label:"${l}"`).join(' OR ')
  const q = `repo:${repo} is:pr is:open (${labelQuery})`

  let page = 1
  while (page <= 10) {
    const result = await githubApi<{
      items?: Array<{
        number: number
        title?: string
        html_url?: string
        created_at?: string
        labels?: Array<{ name?: string } | string>
      }>
    }>(
      `/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}&sort=created&order=asc`,
      token,
    )
    const batch = result.items || []
    if (!batch.length) break
    for (const pr of batch) {
      const labels = labelNames(pr.labels)
      if (!hasAnyLabel(labels, PR_AI_LABELS)) continue
      const id = String(pr.number)
      byId.set(id, {
        externalId: id,
        title: String(pr.title || `#${pr.number}`),
        url: String(pr.html_url || `https://github.com/${repo}/pull/${pr.number}`),
        labels,
        createdAt: String(pr.created_at || new Date(0).toISOString()),
        kind: 'pull_request',
      })
    }
    if (batch.length < 100) break
    page += 1
  }

  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Create missing labels on a GitHub repo (owner/name). Idempotent; skips labels that already exist. */
export async function ensureGitHubRepoLabels(
  token: string,
  fullName: string,
  labels: readonly ForgeLabelSpec[],
): Promise<{ created: number, existing: number }> {
  const repo = normalizeGitHubRepoFullName(fullName)
  const existing = await listGitHubLabelNames(token, repo)
  let created = 0
  let already = 0

  for (const label of labels) {
    if (existing.has(label.name.toLowerCase())) {
      already += 1
      continue
    }

    const color = label.color.replace(/^#/, '')
    const createRes = await safeFetch(`${GITHUB_API}/repos/${repo}/labels`, {
      method: 'POST',
      headers: githubHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: label.name,
        color,
        description: label.description,
      }),
      timeoutMs: 30000,
      expectedOrigin: 'https://api.github.com',
    })

    if (createRes.ok || createRes.status === 422) {
      // 422 = race / already exists
      created += createRes.ok ? 1 : 0
      already += createRes.ok ? 0 : 1
      existing.add(label.name.toLowerCase())
      continue
    }
    if (createRes.status === 401) {
      throw new AppError(401, 'GitHub credentials are invalid or revoked', 'forge_unauthorized')
    }
    if (createRes.status === 403) {
      throw new AppError(403, 'GitHub credentials lack permission to manage labels', 'forge_forbidden')
    }
    const text = redactSecrets(await createRes.text())
    throw new AppError(
      502,
      `GitHub label create failed for "${label.name}" (${createRes.status}): ${text.slice(0, 200)}`,
      'forge_api_error',
    )
  }

  return { created, existing: already }
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

export async function testGitHubToken(token: string): Promise<{
  ok: boolean
  message: string
  account?: ForgeAccount
  canAccessPrivate?: boolean | null
  oauthScopes?: string[]
}> {
  try {
    const account = await fetchGitHubAccount(token)
    const oauthScopes = account.scopes
      ? account.scopes.split(',').map((s) => s.trim()).filter(Boolean)
      : []
    const classicPrivate = githubClassicTokenCanAccessPrivate(oauthScopes)

    if (classicPrivate === false) {
      return {
        ok: false,
        message: GITHUB_PRIVATE_ACCESS_HINT,
        account,
        canAccessPrivate: false,
        oauthScopes,
      }
    }

    // Fine-grained PATs omit X-OAuth-Scopes; probe whether private listing works.
    let canAccessPrivate: boolean | null = classicPrivate
    let message = `Authenticated as ${account.accountLogin}`
    const isFineGrained = token.startsWith('github_pat_')
    if (classicPrivate === null || isFineGrained) {
      const privateBatch = await githubApi<unknown[]>(
        '/user/repos?per_page=1&visibility=private&affiliation=owner,collaborator,organization_member',
        token,
      )
      canAccessPrivate = privateBatch.length > 0 ? true : false
      if (isFineGrained && canAccessPrivate === false) {
        message = `${message}. ${GITHUB_FINE_GRAINED_NO_PRIVATE_HINT}`
      }
    }

    return {
      ok: true,
      message,
      account: {
        ...account,
        scopes: account.scopes || (isFineGrained ? 'fine-grained' : null),
      },
      canAccessPrivate,
      oauthScopes,
      tokenKind: isFineGrained ? 'fine-grained' as const : oauthScopes.length ? 'classic' as const : 'unknown' as const,
    }
  } catch (err) {
    return {
      ok: false,
      message: redactSecrets(err instanceof Error ? err.message : 'GitHub validation failed'),
    }
  }
}
