/**
 * Integration test — requires DATABASE_URL pointing at a disposable database.
 * Skips automatically when DATABASE_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'node:path'
import { bootstrapAdmin, login, setupStatus, countUsers } from '../../server/services/auth'
import { hashPassword } from '../../server/utils/crypto'

const url = process.env.DATABASE_URL
const describeIf = url ? describe : describe.skip

describeIf('auth integration', () => {
  let client: ReturnType<typeof postgres>

  beforeAll(async () => {
    client = postgres(url!, { max: 1 })
    const db = drizzle(client)
    await migrate(db, { migrationsFolder: resolve('database/migrations') })
    // Clean users for isolated run
    await client`truncate login_attempts, sessions, audit_logs, users cascade`
  }, 60000)

  afterAll(async () => {
    await client?.end()
  })

  it('bootstraps admin once and logs in', async () => {
    process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect((await setupStatus()).needsSetup).toBe(true)
    await bootstrapAdmin({
      username: 'admin',
      password: 'integration-test-password',
      bootstrapSecret: 'integration-bootstrap-secret',
      expectedSecret: 'integration-bootstrap-secret',
      ipHash: 'abcd',
    })
    expect(await countUsers()).toBe(1)
    expect((await setupStatus()).needsSetup).toBe(false)

    const session = await login({
      username: 'admin',
      password: 'integration-test-password',
      ipHash: 'abcd',
    })
    expect(session.user.username).toBe('admin')
    expect(session.sessionId.length).toBeGreaterThan(20)
  })
})

// Keep hashPassword referenced for tree-shaking clarity in some runners
void hashPassword
