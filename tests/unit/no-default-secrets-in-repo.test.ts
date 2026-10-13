import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')

/** Former published Compose values — must never reappear as usable defaults. */
const FORMER_PUBLISHED_SECRETS = [
  'n8Kx2mQ7pL4vR9wT1yH6jC3bF5dA0sE2uZ',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
  'wk_7f3a9c2e1b8d4f6a0e5c9b2d7a1f4e8c3b6d9e0a2f5c8',
  'Aw7kP9mX2qR5vN8jL3hC6tY1wE4uS0bZ',
  'changeme',
]

describe('tracked config has no usable default secrets', () => {
  it('docker-compose.yml does not embed known insecure secrets', () => {
    const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8')
    for (const secret of FORMER_PUBLISHED_SECRETS) {
      expect(compose).not.toContain(secret)
    }
    expect(compose).toContain('NUXT_SESSION_PASSWORD: ${NUXT_SESSION_PASSWORD:-}')
    expect(compose).toContain('SECRET_ENCRYPTION_KEY: ${SECRET_ENCRYPTION_KEY:-}')
    expect(compose).toContain('WORKER_INTERNAL_TOKEN: ${WORKER_INTERNAL_TOKEN:-}')
    expect(compose).toContain('INITIAL_ADMIN_BOOTSTRAP_SECRET: ${INITIAL_ADMIN_BOOTSTRAP_SECRET:-}')
    expect(compose).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}')
  })

  it('.env.example is placeholders only', () => {
    const example = readFileSync(resolve(root, '.env.example'), 'utf8')
    for (const secret of FORMER_PUBLISHED_SECRETS) {
      expect(example).not.toContain(secret)
    }
    expect(example).toMatch(/generate-env\.sh/)
    for (const line of example.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      expect(trimmed, `unexpected assignment: ${trimmed}`).toBe('')
    }
  })
})
