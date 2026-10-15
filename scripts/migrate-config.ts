#!/usr/bin/env tsx
/**
 * Import github-projects.conf / gitlab-projects.conf / .env into PostgreSQL.
 * Dry-run by default unless --apply is passed.
 */
import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import { repositories } from '../database/schema'
import { validateRemoteUrl, newWorkspaceId } from '../server/utils/paths'

function argFlag(name: string) {
  return process.argv.includes(name)
}

function argValue(name: string, fallback = '') {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function stripComments(raw: string): string {
  const idx = raw.indexOf('[')
  if (idx < 0) throw new Error('No JSON array found')
  return raw.slice(idx)
}

interface ConfEntry {
  name: string
  path: string
  block_on_open_pr?: boolean
  force_push_to_default?: boolean
}

async function parseConf(path: string): Promise<ConfEntry[]> {
  const raw = await readFile(path, 'utf8')
  const data = JSON.parse(stripComments(raw))
  if (!Array.isArray(data)) throw new Error(`${path} must be a JSON array`)
  return data.map((row, i) => {
    if (!row || typeof row !== 'object') throw new Error(`${path}[${i}] invalid`)
    const name = String((row as any).name || '')
    const localPath = String((row as any).path || (row as any).dir || '')
    if (!name || !localPath) throw new Error(`${path}[${i}] missing name/path`)
    return {
      name,
      path: localPath,
      block_on_open_pr: (row as any).block_on_open_pr !== false,
      force_push_to_default: (row as any).force_push_to_default === true,
    }
  })
}

async function main() {
  const apply = argFlag('--apply')
  const base = resolve(argValue('--base', process.env.AI_WORKER_BASE_DIR || './worker'))
  const report: string[] = []
  const githubPath = resolve(base, 'github-projects.conf')
  const gitlabPath = resolve(base, 'gitlab-projects.conf')

  report.push(`Base: ${base}`)
  report.push(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`)

  const entries: Array<ConfEntry & { forgeType: 'github' | 'gitlab' }> = []

  if (await exists(githubPath)) {
    const rows = await parseConf(githubPath)
    report.push(`Found ${rows.length} GitHub projects in ${githubPath}`)
    entries.push(...rows.map((r) => ({ ...r, forgeType: 'github' as const })))
  } else {
    report.push(`No file: ${githubPath}`)
  }

  if (await exists(gitlabPath)) {
    const rows = await parseConf(gitlabPath)
    report.push(`Found ${rows.length} GitLab projects in ${gitlabPath}`)
    entries.push(...rows.map((r) => ({ ...r, forgeType: 'gitlab' as const })))
  } else {
    report.push(`No file: ${gitlabPath}`)
  }

  if (!process.env.DATABASE_URL) {
    report.push('ERROR: DATABASE_URL required for apply/inspection against DB')
    console.log(report.join('\n'))
    if (apply) process.exit(1)
    process.exit(0)
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 })
  const db = drizzle(client)

  let imported = 0
  let skipped = 0

  for (const entry of entries) {
    const [existing] = await db.select().from(repositories).where(and(
      eq(repositories.name, entry.name),
      eq(repositories.forgeType, entry.forgeType),
    )).limit(1)

    if (existing) {
      report.push(`SKIP existing ${entry.forgeType}/${entry.name}`)
      skipped++
      continue
    }

    // Without a remote URL in conf, store a placeholder that must be edited before enable
    const remoteUrl = `git@placeholder.local:${entry.name}.git`
    const remoteCheck = validateRemoteUrl(remoteUrl)
    if (!remoteCheck.ok) {
      report.push(`INVALID placeholder remote for ${entry.name}`)
      continue
    }

    report.push(`${apply ? 'IMPORT' : 'WOULD IMPORT'} ${entry.forgeType}/${entry.name} path=${entry.path}`)
    if (apply) {
      await db.insert(repositories).values({
        name: entry.name,
        forgeType: entry.forgeType,
        remoteUrl,
        workspaceId: newWorkspaceId(),
        localPath: entry.path,
        blockOnOpenPr: entry.block_on_open_pr !== false,
        forcePushToDefault: entry.force_push_to_default === true,
        isEnabled: false,
        healthStatus: 'unknown',
        healthMessage: 'Imported from conf; set real remote URL and test before enabling',
      })
      imported++
    }
  }

  report.push(`Done. imported=${imported} skipped=${skipped} totalCandidates=${entries.length}`)
  report.push('Original conf files were not modified.')
  console.log(report.join('\n'))
  await client.end()
}

main().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
