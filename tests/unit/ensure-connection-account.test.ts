import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/forge-github', () => ({
  fetchGitHubAccount: vi.fn(),
}))

vi.mock('../../server/services/forge-gitlab', () => ({
  fetchGitLabAccount: vi.fn(),
}))

vi.mock('../../server/utils/crypto', () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v.replace(/^enc:/, ''),
}))

import { getDb } from '../../server/utils/db'
import { fetchGitHubAccount } from '../../server/services/forge-github'
import { ensureConnectionAccount } from '../../server/services/connections'

describe('ensureConnectionAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SECRET_ENCRYPTION_KEY = 'test-encryption-key-32chars!!'
  })

  it('returns stored account without calling forge when id and login exist', async () => {
    const row = {
      id: 'c1',
      provider: 'github',
      status: 'active',
      accountId: '28010102',
      accountLogin: 'sami1367',
      accountName: 'Sami',
      instanceUrl: 'https://github.com',
      accessTokenCiphertext: 'enc:tok',
      refreshTokenCiphertext: null,
      tokenExpiresAt: null,
      scopes: null,
    }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }),
    } as never)

    const result = await ensureConnectionAccount('c1')
    expect(result.row.accountLogin).toBe('sami1367')
    expect(fetchGitHubAccount).not.toHaveBeenCalled()
  })

  it('fetches /user and persists when accountLogin is missing', async () => {
    const row = {
      id: 'c1',
      provider: 'github',
      status: 'active',
      accountId: 'old',
      accountLogin: null,
      accountName: null,
      instanceUrl: 'https://github.com',
      accessTokenCiphertext: 'enc:tok',
      refreshTokenCiphertext: null,
      tokenExpiresAt: null,
      scopes: null,
    }
    const updated = {
      ...row,
      accountId: '28010102',
      accountLogin: 'sami1367',
      accountName: 'Sami',
    }
    const returning = vi.fn().mockResolvedValue([updated])
    const where = vi.fn().mockReturnValue({ returning })
    const set = vi.fn().mockReturnValue({ where })
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    } as never)
    vi.mocked(fetchGitHubAccount).mockResolvedValue({
      accountId: '28010102',
      accountLogin: 'sami1367',
      accountName: 'Sami',
      scopes: null,
    })

    const result = await ensureConnectionAccount('c1')
    expect(fetchGitHubAccount).toHaveBeenCalledWith('tok')
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountId: '28010102',
      accountLogin: 'sami1367',
      accountName: 'Sami',
    }))
    expect(result.row.accountLogin).toBe('sami1367')
  })
})
