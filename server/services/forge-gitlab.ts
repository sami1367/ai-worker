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

export type ForgeLabelSpec = {
  name: string
  color: string
  description: string
}

function gitlabHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'ai-worker-platform',
    ...(extra || {}),
  }
}

async function listGitLabLabelNames(
  instanceUrl: string,
  token: string,
  encodedProject: string,
): Promise<Set<string>> {
  const base = normalizeGitLabInstanceUrl(instanceUrl)
  const names = new Set<string>()
  let page = 1
  while (page <= 20) {
    const res = await safeFetch(
      `${base}/api/v4/projects/${encodedProject}/labels?per_page=100&page=${page}`,
      {
        headers: gitlabHeaders(token),
        timeoutMs: 30000,
        expectedOrigin: base,
      },
    )
    if (res.status === 401) {
      throw new AppError(401, 'GitLab credentials are invalid or revoked', 'forge_unauthorized')
    }
    if (res.status === 403) {
      throw new AppError(403, 'GitLab credentials lack permission to manage labels', 'forge_forbidden')
    }
    if (res.status === 404) {
      throw new AppError(404, 'GitLab project not found', 'forge_not_found')
    }
    if (!res.ok) {
      const text = redactSecrets(await res.text())
      throw new AppError(502, `GitLab list labels failed (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
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
  kind: 'issue' | 'merge_request'
  /** Source branch for MRs (used in worker block messages). */
  sourceBranch?: string | null
}

const ISSUE_AI_LABELS = ['ai', 'ai-working', 'ai-failed', 'ai-pr', 'ai-answered'] as const
const MR_AI_LABELS = [
  'ai', 'ai-working', 'ai-failed', 'ai-pr',
  'ai-review', 'ai-reviewing', 'ai-reviewed', 'ai-review-failed',
] as const

function normalizeGitLabProjectPath(projectPath: string): string {
  return projectPath.replace(/^\//, '').replace(/\.git$/, '')
}

function gitlabLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return labels.map((l) => {
    if (typeof l === 'string') return l
    if (l && typeof l === 'object' && 'name' in l) return String((l as { name: string }).name)
    return ''
  }).filter(Boolean)
}

/** Open issues carrying any AI implement workflow label. */
export async function listGitLabAiIssues(
  instanceUrl: string,
  token: string,
  projectPath: string,
): Promise<ForgeLabeledItem[]> {
  const encoded = encodeURIComponent(normalizeGitLabProjectPath(projectPath))
  const byId = new Map<string, ForgeLabeledItem>()

  for (const label of ISSUE_AI_LABELS) {
    let page = 1
    while (page <= 10) {
      const { data: batch } = await gitlabApi<Array<{
        iid: number
        title?: string
        web_url?: string
        created_at?: string
        labels?: unknown
      }>>(
        instanceUrl,
        `/projects/${encoded}/issues?state=opened&labels=${encodeURIComponent(label)}`
        + `&per_page=100&page=${page}&order_by=created_at&sort=asc`,
        token,
      )
      if (!batch.length) break
      for (const issue of batch) {
        const labels = gitlabLabelNames(issue.labels)
        const id = String(issue.iid)
        byId.set(id, {
          externalId: id,
          title: String(issue.title || `#${issue.iid}`),
          url: String(issue.web_url || ''),
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

function isAiIssueBranchName(branch: string | null | undefined): boolean {
  return Boolean(branch && /^ai\/issue-\d+(-|$)/.test(branch))
}

/**
 * Open MRs carrying any AI implement or review workflow label, or whose
 * source_branch is ai/issue-* (safety net when ai-pr was not applied).
 */
export async function listGitLabAiMergeRequests(
  instanceUrl: string,
  token: string,
  projectPath: string,
): Promise<ForgeLabeledItem[]> {
  const encoded = encodeURIComponent(normalizeGitLabProjectPath(projectPath))
  const byId = new Map<string, ForgeLabeledItem>()

  for (const label of MR_AI_LABELS) {
    let page = 1
    while (page <= 10) {
      const { data: batch } = await gitlabApi<Array<{
        iid: number
        title?: string
        web_url?: string
        created_at?: string
        source_branch?: string
        labels?: unknown
      }>>(
        instanceUrl,
        `/projects/${encoded}/merge_requests?state=opened&labels=${encodeURIComponent(label)}`
        + `&per_page=100&page=${page}&order_by=created_at&sort=asc`,
        token,
      )
      if (!batch.length) break
      for (const mr of batch) {
        const labels = gitlabLabelNames(mr.labels)
        const id = String(mr.iid)
        byId.set(id, {
          externalId: id,
          title: String(mr.title || `!${mr.iid}`),
          url: String(mr.web_url || ''),
          labels,
          createdAt: String(mr.created_at || new Date(0).toISOString()),
          kind: 'merge_request',
          sourceBranch: mr.source_branch || null,
        })
      }
      if (batch.length < 100) break
      page += 1
    }
  }

  // Safety net: include unlabeled AI issue branches (parity with worker gating).
  let page = 1
  while (page <= 10) {
    const { data: batch } = await gitlabApi<Array<{
      iid: number
      title?: string
      web_url?: string
      created_at?: string
      source_branch?: string
      labels?: unknown
    }>>(
      instanceUrl,
      `/projects/${encoded}/merge_requests?state=opened`
      + `&per_page=100&page=${page}&order_by=created_at&sort=asc`,
      token,
    )
    if (!batch.length) break
    for (const mr of batch) {
      const id = String(mr.iid)
      if (byId.has(id)) continue
      const sourceBranch = mr.source_branch || null
      if (!isAiIssueBranchName(sourceBranch)) continue
      byId.set(id, {
        externalId: id,
        title: String(mr.title || `!${mr.iid}`),
        url: String(mr.web_url || ''),
        labels: gitlabLabelNames(mr.labels),
        createdAt: String(mr.created_at || new Date(0).toISOString()),
        kind: 'merge_request',
        sourceBranch,
      })
    }
    if (batch.length < 100) break
    page += 1
  }

  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Create missing labels on a GitLab project. Idempotent; skips labels that already exist. */
export async function ensureGitLabProjectLabels(
  instanceUrl: string,
  token: string,
  projectPath: string,
  labels: readonly ForgeLabelSpec[],
): Promise<{ created: number, existing: number }> {
  const base = normalizeGitLabInstanceUrl(instanceUrl)
  const encodedProject = encodeURIComponent(projectPath.replace(/^\//, '').replace(/\.git$/, ''))
  const existing = await listGitLabLabelNames(instanceUrl, token, encodedProject)
  let created = 0
  let already = 0

  for (const label of labels) {
    if (existing.has(label.name.toLowerCase())) {
      already += 1
      continue
    }

    const color = label.color.startsWith('#') ? label.color : `#${label.color}`
    const createRes = await safeFetch(`${base}/api/v4/projects/${encodedProject}/labels`, {
      method: 'POST',
      headers: gitlabHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: label.name,
        color,
        description: label.description,
      }),
      timeoutMs: 30000,
      expectedOrigin: base,
    })

    if (createRes.ok || createRes.status === 400 || createRes.status === 409) {
      created += createRes.ok ? 1 : 0
      already += createRes.ok ? 0 : 1
      existing.add(label.name.toLowerCase())
      continue
    }
    if (createRes.status === 401) {
      throw new AppError(401, 'GitLab credentials are invalid or revoked', 'forge_unauthorized')
    }
    if (createRes.status === 403) {
      throw new AppError(403, 'GitLab credentials lack permission to manage labels', 'forge_forbidden')
    }
    const text = redactSecrets(await createRes.text())
    throw new AppError(
      502,
      `GitLab label create failed for "${label.name}" (${createRes.status}): ${text.slice(0, 200)}`,
      'forge_api_error',
    )
  }

  return { created, existing: already }
}

export type GitLabWebhookHook = {
  id: number
  url: string
  issuesEvents: boolean
  mergeRequestsEvents: boolean
}

/** List project webhooks (Maintainer+ required). */
export async function listGitLabProjectWebhooks(
  instanceUrl: string,
  token: string,
  projectPath: string,
): Promise<GitLabWebhookHook[]> {
  const base = normalizeGitLabInstanceUrl(instanceUrl)
  const encodedProject = encodeURIComponent(projectPath.replace(/^\//, '').replace(/\.git$/, ''))
  const res = await safeFetch(
    `${base}/api/v4/projects/${encodedProject}/hooks?per_page=100`,
    {
      headers: gitlabHeaders(token),
      timeoutMs: 30000,
      expectedOrigin: base,
    },
  )
  if (res.status === 401) {
    throw new AppError(401, 'GitLab credentials are invalid or revoked', 'forge_unauthorized')
  }
  if (res.status === 403) {
    throw new AppError(403, 'GitLab credentials lack permission to manage webhooks', 'forge_forbidden')
  }
  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(502, `GitLab hooks list failed (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
  }
  const hooks = await res.json() as Array<{
    id: number
    url?: string
    issues_events?: boolean
    merge_requests_events?: boolean
  }>
  return hooks.map((h) => ({
    id: h.id,
    url: String(h.url || ''),
    issuesEvents: Boolean(h.issues_events),
    mergeRequestsEvents: Boolean(h.merge_requests_events),
  }))
}

/**
 * Ensure a GitLab project webhook delivers issue + MR events to our URL.
 * Updates an existing hook with the same URL; otherwise creates one.
 */
export async function ensureGitLabProjectWebhook(opts: {
  instanceUrl: string
  token: string
  projectPath: string
  callbackUrl: string
  secret: string
}): Promise<{ hookId: number, created: boolean, updated: boolean }> {
  const base = normalizeGitLabInstanceUrl(opts.instanceUrl)
  const encodedProject = encodeURIComponent(
    opts.projectPath.replace(/^\//, '').replace(/\.git$/, ''),
  )
  const existing = await listGitLabProjectWebhooks(opts.instanceUrl, opts.token, opts.projectPath)
  const match = existing.find((h) => h.url === opts.callbackUrl)

  const body = {
    url: opts.callbackUrl,
    token: opts.secret,
    enable_ssl_verification: true,
    issues_events: true,
    merge_requests_events: true,
    push_events: false,
    tag_push_events: false,
    note_events: false,
    pipeline_events: false,
    wiki_page_events: false,
    deployment_events: false,
    job_events: false,
    releases_events: false,
  }

  if (match) {
    const res = await safeFetch(`${base}/api/v4/projects/${encodedProject}/hooks/${match.id}`, {
      method: 'PUT',
      headers: gitlabHeaders(opts.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      timeoutMs: 30000,
      expectedOrigin: base,
    })
    if (!res.ok) {
      const text = redactSecrets(await res.text())
      throw new AppError(502, `GitLab hook update failed (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
    }
    return { hookId: match.id, created: false, updated: true }
  }

  const res = await safeFetch(`${base}/api/v4/projects/${encodedProject}/hooks`, {
    method: 'POST',
    headers: gitlabHeaders(opts.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    timeoutMs: 30000,
    expectedOrigin: base,
  })
  if (res.status === 401) {
    throw new AppError(401, 'GitLab credentials are invalid or revoked', 'forge_unauthorized')
  }
  if (res.status === 403) {
    throw new AppError(403, 'GitLab credentials lack permission to manage webhooks', 'forge_forbidden')
  }
  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(502, `GitLab hook create failed (${res.status}): ${text.slice(0, 200)}`, 'forge_api_error')
  }
  const created = await res.json() as { id: number }
  return { hookId: created.id, created: true, updated: false }
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
