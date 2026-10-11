import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashPassword, safeEqual, verifyPassword } from '../../server/utils/crypto'

describe('crypto', () => {
  it('hashes and verifies passwords with argon2', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).not.toContain('correct horse')
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(hash, 'wrong')).toBe(false)
  })

  it('encrypts and decrypts secrets with AES-GCM', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const cipher = encryptSecret('super-secret-token', key)
    expect(cipher.startsWith('v1:')).toBe(true)
    expect(cipher).not.toContain('super-secret-token')
    expect(decryptSecret(cipher, key)).toBe('super-secret-token')
  })

  it('safeEqual compares strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })
})
