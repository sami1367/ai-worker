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
  console.error('Migration failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
