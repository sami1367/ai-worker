import { createHash } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { promptTemplates } from '#db/schema'
import { getDb } from '#utils/db'
import { AppError } from '#utils/errors'
import { writeAudit } from './audit'

type PromptKind = 'template' | 'snippet'
type TaskType =
  | 'github_issue'
  | 'gitlab_issue'
  | 'github_pr_implement'
  | 'gitlab_mr_implement'
  | 'github_pr_review'
  | 'gitlab_mr_review'
  | 'release'

export interface PromptCatalogEntry {
  path: string
  kind: PromptKind
  taskType: TaskType | null
  displayName: string
  description: string
}

/** Canonical prompt keys seeded from worker/prompts/. */
export const PROMPT_CATALOG: PromptCatalogEntry[] = [
  {
    path: 'github-issue-implement.txt',
    kind: 'template',
    taskType: 'github_issue',
    displayName: 'GitHub issue implement',
    description: 'Used when a GitHub issue is labeled ai',
  },
  {
    path: 'gitlab-issue-implement.txt',
    kind: 'template',
    taskType: 'gitlab_issue',
    displayName: 'GitLab issue implement',
    description: 'Used when a GitLab issue is labeled ai',
  },
  {
    path: 'github-pr-implement.txt',
    kind: 'template',
    taskType: 'github_pr_implement',
    displayName: 'GitHub PR implement',
    description: 'Used when a GitHub PR is labeled ai',
  },
  {
    path: 'gitlab-mr-implement.txt',
    kind: 'template',
    taskType: 'gitlab_mr_implement',
    displayName: 'GitLab MR implement',
    description: 'Used when a GitLab MR is labeled ai',
  },
  {
    path: 'github-pr-review.txt',
    kind: 'template',
    taskType: 'github_pr_review',
    displayName: 'GitHub PR review',
    description: 'Used when a GitHub PR is labeled ai-review',
  },
  {
    path: 'gitlab-mr-review.txt',
    kind: 'template',
    taskType: 'gitlab_mr_review',
    displayName: 'GitLab MR review',
    description: 'Used when a GitLab MR is labeled ai-review',
  },
  {
    path: 'snippets/comments-priority.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Comments priority',
    description: 'Comments override title/description; newest wins',
  },
  {
    path: 'snippets/decline-unrelated-task.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Decline unrelated task',
    description: 'Skip implementation with empty PR/MR and explanation',
  },
  {
    path: 'snippets/minimal-changes.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Minimal changes',
    description: 'Required change only; no drive-by refactors',
  },
  {
    path: 'snippets/implement-process.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Implement process',
    description: 'Issue implementation steps',
  },
  {
    path: 'snippets/test-coverage.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Test coverage',
    description: 'Tests must cover >80% of changed executable lines',
  },
  {
    path: 'snippets/implement-final-response.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Implement final response',
    description: 'What to report after implementing',
  },
  {
    path: 'snippets/implement-merge-notes.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Implement merge notes',
    description: 'Write merge/PR notes for the runner comment',
  },
  {
    path: 'snippets/related-services.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Related services',
    description: 'List other registered repos affected by the change',
  },
  {
    path: 'snippets/followup-review.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Follow-up review',
    description: 'Re-review after human replies; role handling',
  },
  {
    path: 'snippets/review-scope.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Review scope',
    description: 'Review only the current PR/MR diff',
  },
  {
    path: 'snippets/review-tests.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Review tests',
    description: 'Read/run tests and report coverage of the change',
  },
  {
    path: 'snippets/review-output-guidelines.txt',
    kind: 'snippet',
    taskType: null,
    displayName: 'Review output guidelines',
    description: 'Markdown structure for review comments',
  },
]

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function promptSeedDir(): string {
  if (process.env.PROMPT_SEED_DIR) return process.env.PROMPT_SEED_DIR
  return join(process.cwd(), 'worker/prompts')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Resolve seed root: Docker image layout first, then cwd. */
export async function resolvePromptSeedDir(): Promise<string> {
  if (process.env.PROMPT_SEED_DIR) return process.env.PROMPT_SEED_DIR
  const candidates = ['/app/worker/prompts', join(process.cwd(), 'worker/prompts')]
  for (const dir of candidates) {
    if (await pathExists(dir)) return dir
  }
  return promptSeedDir()
}

async function readSeedFile(seedDir: string, relativePath: string): Promise<string | null> {
  const full = join(seedDir, relativePath)
  try {
    return await readFile(full, 'utf8')
  } catch {
    return null
  }
}

async function discoverExtraSeedPaths(seedDir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(rel: string) {
    const abs = join(seedDir, rel)
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(childRel)
      } else if (entry.isFile() && entry.name.endsWith('.txt')) {
        found.push(childRel)
      }
    }
  }
  await walk('')
  return found
}

function catalogMeta(path: string): PromptCatalogEntry {
  const known = PROMPT_CATALOG.find((e) => e.path === path)
  if (known) return known
  const kind: PromptKind = path.startsWith('snippets/') ? 'snippet' : 'template'
  const base = path.split('/').pop()?.replace(/\.txt$/, '') || path
  return {
    path,
    kind,
    taskType: null,
    displayName: base.replace(/-/g, ' '),
    description: 'Custom prompt file',
  }
}

/**
 * Seed prompt rows from filesystem templates.
 * Inserts missing paths only — never overwrites operator-edited content.
 */
export async function ensurePromptRows(): Promise<{ inserted: number; total: number }> {
  const db = getDb()
  const seedDir = await resolvePromptSeedDir()
  const catalogPaths = new Set(PROMPT_CATALOG.map((e) => e.path))
  const discovered = await discoverExtraSeedPaths(seedDir)
  const allPaths = [...new Set([...catalogPaths, ...discovered])].sort()

  let inserted = 0
  for (const path of allPaths) {
    const content = await readSeedFile(seedDir, path)
    if (content == null) {
      console.warn(`[prompts] Seed file missing: ${join(seedDir, path)}`)
      continue
    }
    const meta = catalogMeta(path)
    const result = await db.insert(promptTemplates).values({
      path: meta.path,
      kind: meta.kind,
      taskType: meta.taskType,
      displayName: meta.displayName,
      description: meta.description,
      content,
      contentVersion: 1,
      seedChecksum: checksum(content),
    }).onConflictDoNothing({ target: promptTemplates.path }).returning({ id: promptTemplates.id })

    if (result.length) inserted += 1
  }

  const rows = await db.select({ id: promptTemplates.id }).from(promptTemplates)
  return { inserted, total: rows.length }
}

function publicPrompt(row: typeof promptTemplates.$inferSelect, opts?: { includeContent?: boolean }) {
  const includeContent = opts?.includeContent !== false
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    taskType: row.taskType,
    displayName: row.displayName,
    description: row.description,
    contentVersion: row.contentVersion,
    seedChecksum: row.seedChecksum,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    ...(includeContent ? { content: row.content } : {}),
  }
}

export async function listPrompts(opts?: { includeContent?: boolean }) {
  await ensurePromptRows()
  const db = getDb()
  const rows = await db.select().from(promptTemplates)
    .orderBy(asc(promptTemplates.kind), asc(promptTemplates.path))
  return rows.map((r) => publicPrompt(r, opts))
}

export async function getPromptById(id: string) {
  const db = getDb()
  const [row] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)
  if (!row) throw new AppError(404, 'Prompt not found', 'not_found')
  return publicPrompt(row)
}

export async function getPromptByPath(path: string) {
  const db = getDb()
  const [row] = await db.select().from(promptTemplates).where(eq(promptTemplates.path, path)).limit(1)
  if (!row) throw new AppError(404, 'Prompt not found', 'not_found')
  return publicPrompt(row)
}

/** Full content payload for the worker (sync before each job). */
export async function listPromptsForWorker() {
  await ensurePromptRows()
  const db = getDb()
  const rows = await db.select({
    path: promptTemplates.path,
    content: promptTemplates.content,
    contentVersion: promptTemplates.contentVersion,
    kind: promptTemplates.kind,
  }).from(promptTemplates).orderBy(asc(promptTemplates.path))

  return {
    items: rows,
    fetchedAt: new Date().toISOString(),
  }
}

export async function updatePrompt(
  id: string,
  input: { content: string },
  actor: { id: string, username: string },
  ipHash?: string,
) {
  if (typeof input.content !== 'string' || !input.content.trim()) {
    throw new AppError(400, 'Prompt content is required', 'validation_error')
  }
  if (input.content.length > 500_000) {
    throw new AppError(400, 'Prompt content is too large', 'validation_error')
  }

  const db = getDb()
  const [existing] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)
  if (!existing) throw new AppError(404, 'Prompt not found', 'not_found')

  const [row] = await db.update(promptTemplates).set({
    content: input.content,
    contentVersion: existing.contentVersion + 1,
    updatedAt: new Date(),
    updatedBy: actor.id,
  }).where(eq(promptTemplates.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'prompt.update',
    targetType: 'prompt',
    targetId: row.path,
    metadata: {
      contentVersion: row.contentVersion,
      previousVersion: existing.contentVersion,
      bytes: input.content.length,
    },
    ipHash,
  })

  return publicPrompt(row)
}

/** Restore content from the seed file on disk (image / checkout). */
export async function resetPromptToSeed(
  id: string,
  actor: { id: string, username: string },
  ipHash?: string,
) {
  const db = getDb()
  const [existing] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)
  if (!existing) throw new AppError(404, 'Prompt not found', 'not_found')

  const seedDir = await resolvePromptSeedDir()
  const content = await readSeedFile(seedDir, existing.path)
  if (content == null) {
    throw new AppError(404, `Seed file not found for ${existing.path}`, 'not_found')
  }

  const meta = catalogMeta(existing.path)
  const [row] = await db.update(promptTemplates).set({
    content,
    displayName: meta.displayName,
    description: meta.description,
    kind: meta.kind,
    taskType: meta.taskType,
    contentVersion: existing.contentVersion + 1,
    seedChecksum: checksum(content),
    updatedAt: new Date(),
    updatedBy: actor.id,
  }).where(eq(promptTemplates.id, id)).returning()

  await writeAudit({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action: 'prompt.reset',
    targetType: 'prompt',
    targetId: row.path,
    metadata: { contentVersion: row.contentVersion },
    ipHash,
  })

  return publicPrompt(row)
}
