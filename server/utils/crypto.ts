import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'

const ARGON2_OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password)
  } catch {
    return false
  }
}

function encryptionKeyBytes(keyMaterial: string): Buffer {
  // Accept 64-char hex or derive from passphrase-like material
  if (/^[0-9a-fA-F]{64}$/.test(keyMaterial)) {
    return Buffer.from(keyMaterial, 'hex')
  }
  return createHash('sha256').update(keyMaterial).digest()
}

export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const key = encryptionKeyBytes(keyMaterial)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(ciphertext: string, keyMaterial: string): string {
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported ciphertext format')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const key = encryptionKeyBytes(keyMaterial)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function newCorrelationId(): string {
  return randomBytes(16).toString('hex')
}

export function newSessionId(): string {
  return randomBytes(32).toString('hex')
}
