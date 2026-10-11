#!/usr/bin/env tsx
import { checkDatabaseConnectivity } from '../server/utils/db'

async function main() {
  const db = await checkDatabaseConnectivity()
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    database: db,
    node: process.version,
    env: {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasSessionSecret: Boolean(process.env.NUXT_SESSION_PASSWORD || process.env.SESSION_SECRET),
      hasEncryptionKey: Boolean(process.env.SECRET_ENCRYPTION_KEY),
      hasWorkerToken: Boolean(process.env.WORKER_INTERNAL_TOKEN),
    },
  }, null, 2))
  if (!db.ok) process.exit(2)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
