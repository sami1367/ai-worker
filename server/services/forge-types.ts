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

export interface TokenBundle {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  scopes?: string | null
}
