import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '#db/schema'

let client: ReturnType<typeof postgres> | null = null
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
  if (dbInstance) return dbInstance

  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not configured')
  }

  client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })
  dbInstance = drizzle(client, { schema })
  return dbInstance
}

export async function checkDatabaseConnectivity(): Promise<{ ok: boolean; message: string }> {
  try {
    const url = process.env.DATABASE_URL
    if (!url) return { ok: false, message: 'DATABASE_URL is not configured' }
    // Use a short-lived client so readiness checks do not require a warmed pool
    const probe = postgres(url, { max: 1, connect_timeout: 5 })
    try {
      await probe`select 1`
      return { ok: true, message: 'connected' }
    } finally {
      await probe.end({ timeout: 5 })
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'database unreachable',
    }
  }
}

export type Db = ReturnType<typeof getDb>
