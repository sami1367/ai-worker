import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { resolve } from 'node:path'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('ERROR: DATABASE_URL is required')
    process.exit(1)
  }

  const client = postgres(url, { max: 1 })
  const db = drizzle(client)

  const migrationsFolder = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'migrations')
  console.log(`Running migrations from ${migrationsFolder}`)
  await migrate(db, { migrationsFolder })
  console.log('Migrations complete')
  await client.end()
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('Migration failed:', msg)
  // drizzle often wraps auth failures as "Failed query: CREATE SCHEMA ..."
  if (/password authentication failed|ECONNREFUSED|ENOTFOUND/i.test(msg)
    || /Failed query:\s*CREATE SCHEMA/i.test(msg)) {
    console.error(
      'Hint: Postgres rejected the connection. If you changed POSTGRES_PASSWORD in compose '
      + 'after the first start, the old volume still has the previous password. '
      + 'For a fresh install: docker compose down -v && docker compose up -d',
    )
  }
  process.exit(1)
})
