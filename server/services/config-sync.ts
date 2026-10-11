import { mkdir, rename, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { repositories } from '#db/schema'
import { getDb } from '#utils/db'
import { workerBaseDir } from '#utils/paths'
import { getSettings, bumpConfigVersion } from './settings'
import { writeAudit } from './audit'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ExportedProject {
  name: string
  path: string
  block_on_open_pr: boolean
}

async function atomicWriteJson(targetPath: string, data: unknown) {
  await mkdir(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify(data, null, 2)}\n`
  await writeFile(tmp, body, { mode: 0o600 })

  // Validate with jq when available
  try {
    await execFileAsync('jq', ['empty', tmp], { timeout: 5000 })
  } catch {
    // Fallback: JSON.parse
    JSON.parse(await readFile(tmp, 'utf8'))
  }

  await rename(tmp, targetPath)
}

export async function exportWorkerConfig(actor?: { id: string, username: string }) {
  const db = getDb()
  const rows = await db.select().from(repositories).where(eq(repositories.isArchived, false))

  const github: ExportedProject[] = []
  const gitlab: ExportedProject[] = []

  for (const row of rows) {
    if (!row.isEnabled) continue
    if (!row.localPath) continue
    const entry: ExportedProject = {
      name: row.name,
      path: row.localPath,
      block_on_open_pr: row.blockOnOpenPr,
    }
    if (row.forgeType === 'github') github.push(entry)
    else gitlab.push(entry)
  }

  const base = workerBaseDir()
  const githubPath = join(base, 'github-projects.conf')
  const gitlabPath = join(base, 'gitlab-projects.conf')

  // Never overwrite a valid file with empty arrays if we failed to read DB — we have rows.
  // Writing empty arrays is valid when no repos enabled.
  await atomicWriteJson(githubPath, github)
  await atomicWriteJson(gitlabPath, gitlab)

  const settings = await getSettings()
  const next = await bumpConfigVersion(actor)

  if (actor) {
    await writeAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      action: 'config.export',
      targetType: 'config',
      metadata: {
        githubCount: github.length,
        gitlabCount: gitlab.length,
        configVersion: next.configVersion,
        previousVersion: settings.configVersion,
      },
    })
  }

  return {
    githubPath,
    gitlabPath,
    githubCount: github.length,
    gitlabCount: gitlab.length,
    configVersion: next.configVersion,
  }
}

export async function readExportedConfig() {
  const base = workerBaseDir()
  const readSafe = async (file: string) => {
    try {
      const raw = await readFile(join(base, file), 'utf8')
      // Strip leading comments
      const jsonStart = raw.indexOf('[')
      return jsonStart >= 0 ? JSON.parse(raw.slice(jsonStart)) : []
    } catch {
      return null
    }
  }
  return {
    github: await readSafe('github-projects.conf'),
    gitlab: await readSafe('gitlab-projects.conf'),
  }
}
