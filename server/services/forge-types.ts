export interface ForgeRepo {
  providerRepoId: string
  fullName: string
  ownerLogin: string
  name: string
  description: string | null
  visibility: string
  defaultBranch: string
  cloneUrlHttps: string
  htmlUrl: string | null
  permissions: Record<string, unknown>
  isArchived: boolean
  isFork: boolean
}

export interface ForgeAccount {
  accountId: string
  accountLogin: string
  accountName: string | null
  scopes: string | null
}

/** Forge issue/PR assignee (GitHub login or GitLab username). */
export interface ForgeAssignee {
  id: string
  login: string
}

/**
 * True when the connected forge account is among the item's assignees.
 * Unassigned items never match — AI labels alone are not enough to work.
 */
export function isAssignedToForgeAccount(
  assignees: ForgeAssignee[] | undefined | null,
  account: { accountId?: string | null, accountLogin?: string | null },
): boolean {
  if (!assignees?.length) return false
  const login = account.accountLogin?.trim().toLowerCase()
  const id = account.accountId?.trim()
  if (!login && !id) return false
  return assignees.some((a) => {
    if (id && a.id && String(a.id) === id) return true
    if (login && a.login && a.login.trim().toLowerCase() === login) return true
    return false
  })
}

/**
 * True when the issue reporter (author) is allowed by the repository allowlist.
 * Empty / missing list means all reporters are accepted.
 * When the list is non-empty, the author login must match (case-insensitive).
 */
export function isAcceptedReporter(
  author: ForgeAssignee | null | undefined,
  acceptedLogins: string[] | undefined | null,
): boolean {
  if (!acceptedLogins?.length) return true
  const login = author?.login?.trim().toLowerCase()
  if (!login) return false
  const allowed = new Set(
    acceptedLogins.map((l) => l.trim().toLowerCase()).filter(Boolean),
  )
  if (!allowed.size) return true
  return allowed.has(login)
}

export interface TokenBundle {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  scopes?: string | null
}
