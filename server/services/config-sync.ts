import { mkdir, rename, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { repositories } from '#db/schema'
import { getDb } from '#utils/db'
import { workerBaseDir } from '#utils/paths'
import { listPausedConnectionIds, shouldExposeRepositoryForConnection } from './connections'
import { getSettings, bumpConfigVersion } from './settings'
import { writeAudit } from './audit'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ExportedProject {
  name: string
  path: string
  block_on_open_pr: boolean
  /** Forge default branch (main, master, develop, …). Used as PR/MR base. */
  default_branch: string
  /**
   * When true, issue implement force-pushes commits onto default_branch
   * instead of opening a pull/merge request. Default false.
   */
  force_push_to_default: boolean
  /** Forge identity for polling without a local clone (lazy workspace). */
  full_name: string
  remote_url: string
  forge: 'github' | 'gitlab'
  /** Optional per-repo instructions appended to every AI prompt. Omitted when empty. */
  custom_prompt?: string
}

/** Derive org/repo (or group/project) from a remote URL when canonical id is missing. */
export function fullNameFromRemoteUrl(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/i, '')
  const ssh = cleaned.match(/^git@[^:]+:(.+)$/)
  if (ssh?.[1]) return ssh[1].replace(/^\/+/, '')
  const https = cleaned.match(/^https?:\/\/[^/]+\/(.+)$/i)
  if (https?.[1]) return https[1].replace(/^\/+/, '')
  const sshUrl = cleaned.match(/^ssh:\/\/git@[^/]+\/(.+)$/i)
  if (sshUrl?.[1]) return sshUrl[1].replace(/^\/+/, '')
  return null
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

export async function exportWorkerConfig(
  actor?: { id?: string | null, username: string },
  opts?: { forceBump?: boolean },
) {
  const db = getDb()
  const rows = await db.select().from(repositories).where(eq(repositories.isArchived, false))
  const pausedConnectionIds = new Set(await listPausedConnectionIds())

  const github: ExportedProject[] = []
  const gitlab: ExportedProject[] = []

  for (const row of rows) {
    if (!row.isEnabled) continue
    if (!shouldExposeRepositoryForConnection(row.connectionId, pausedConnectionIds)) continue
    if (!row.localPath) continue
    const fullName = row.canonicalProjectIdentifier
      || fullNameFromRemoteUrl(row.remoteUrl)
      || row.name
    const customPromptRaw = row.settings && typeof row.settings.customPrompt === 'string'
      ? row.settings.customPrompt
      : ''
    const customPrompt = customPromptRaw.trim()
    const entry: ExportedProject = {
      name: row.name,
      path: row.localPath,
      block_on_open_pr: row.blockOnOpenPr,
      default_branch: row.defaultBranch || 'main',
      force_push_to_default: row.forcePushToDefault === true,
      full_name: fullName,
      remote_url: row.remoteUrl,
      forge: row.forgeType,
      ...(customPrompt ? { custom_prompt: customPrompt } : {}),
    }
    if (row.forgeType === 'github') github.push(entry)
    else gitlab.push(entry)
  }

  const base = workerBaseDir()
  const githubPath = join(base, 'github-projects.conf')
  const gitlabPath = join(base, 'gitlab-projects.conf')

  const previous = await readExportedConfig()
  const changed = JSON.stringify(previous.github) !== JSON.stringify(github)
    || JSON.stringify(previous.gitlab) !== JSON.stringify(gitlab)

  // Never overwrite a valid file with empty arrays if we failed to read DB — we have rows.
  // Writing empty arrays is valid when no repos enabled.
  await atomicWriteJson(githubPath, github)
  await atomicWriteJson(gitlabPath, gitlab)

  const settings = await getSettings()
  const shouldBump = opts?.forceBump || changed
  const next = shouldBump ? await bumpConfigVersion(actor) : settings

  if (actor && shouldBump) {
    await writeAudit({
      actorUserId: actor.id || null,
      actorUsername: actor.username,
      action: 'config.export',
      targetType: 'config',
      metadata: {
        githubCount: github.length,
        gitlabCount: gitlab.length,
        configVersion: next.configVersion,
        previousVersion: settings.configVersion,
        changed,
      },
    })
  }

  // New/enabled/disabled repos: wake the poll loop so conf is used immediately.
  if (changed) {
    try {
      const { wakeWorkerPoll } = await import('./webhooks')
      await wakeWorkerPoll('config.export', {
        githubCount: github.length,
        gitlabCount: gitlab.length,
        configVersion: next.configVersion,
      })
    } catch {
      // best-effort
    }
  }

  return {
    githubPath,
    gitlabPath,
    githubCount: github.length,
    gitlabCount: gitlab.length,
    configVersion: next.configVersion,
    changed,
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
