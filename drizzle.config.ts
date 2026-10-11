import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './database/schema/index.ts',
  out: './database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://aiworker:aiworker@127.0.0.1:5432/aiworker',
  },
  strict: true,
  verbose: true,
})
