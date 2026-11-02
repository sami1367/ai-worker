import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.nuxt',
  '.output',
  'dist',
  'build',
  'coverage',
  '.next',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.codegraph',
  '.turbo',
  '.cache',
])

const KEY_FILES = [
  'README.md',
  'README.MD',
  'readme.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'docker-compose.yml',
  'Dockerfile',
  'nuxt.config.ts',
  'tsconfig.json',
]

const MAX_TREE_ENTRIES = 220
const MAX_FILE_BYTES = 12_000
const MAX_CONTEXT_CHARS = 28_000

async function walkTree(
  root: string,
  dir: string,
  out: string[],
  depth: number,
): Promise<void> {
  if (out.length >= MAX_TREE_ENTRIES || depth > 4) return
  let entries: Array<{ name: string, isDirectory: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true }) as Array<{ name: string, isDirectory: () => boolean }>
  } catch {
    return
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= MAX_TREE_ENTRIES) break
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitlab') {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name !== '.github' && entry.name !== '.gitlab') continue
    }
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    const rel = relative(root, full).split(sep).join('/')
    if (entry.isDirectory()) {
      out.push(`${rel}/`)
      await walkTree(root, full, out, depth + 1)
    } else {
      out.push(rel)
    }
  }
}

async function readKeyFiles(root: string): Promise<string[]> {
  const chunks: string[] = []
  for (const name of KEY_FILES) {
    const full = join(root, name)
    try {
      const st = await stat(full)
      if (!st.isFile() || st.size > 200_000) continue
      const raw = await readFile(full, 'utf8')
      const sliced = raw.slice(0, MAX_FILE_BYTES)
      chunks.push(`### ${name}\n\`\`\`\n${sliced}\n\`\`\``)
    } catch {
      // missing
    }
  }
  return chunks
}

async function tryCodegraphSummary(root: string, epicHint: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'codegraph',
      ['explore', '--json', epicHint.slice(0, 200) || 'project architecture overview modules'],
      {
        cwd: root,
        timeout: 12_000,
        maxBuffer: 512_000,
        env: { ...process.env, PATH: process.env.PATH },
      },
    )
    const text = String(stdout || '').trim()
    if (!text) return null
    return text.slice(0, 8_000)
  } catch {
    return null
  }
}

/** True when a stored summary came from a readable workspace (not an unavailable stub). */
export function isCodeContextSummaryAvailable(summary: string | null | undefined): boolean {
  if (!summary) return false
  if (summary.includes('Plan from the product description only')) return false
  if (summary.includes('not a directory')) return false
  return true
}

/**
 * Build a live code context summary from a cloned workspace for task planning.
 */
export async function buildRepoCodeContext(opts: {
  localPath: string | null | undefined
  workspaceStatus?: string | null
  epicHint?: string
}): Promise<{ summary: string, available: boolean }> {
  const root = opts.localPath?.trim()
  if (!root || opts.workspaceStatus === 'not_cloned' || opts.workspaceStatus === 'failed') {
    return {
      available: false,
      summary: 'Workspace is not cloned yet. Plan from the product description only; suggest the operator clone/sync the repository for richer code-aware tasks.',
    }
  }

  try {
    const st = await stat(root)
    if (!st.isDirectory()) {
      return { available: false, summary: 'Workspace path is not a directory.' }
    }
  } catch {
    return {
      available: false,
      summary: 'Workspace path is not accessible on this host. Plan from the product description only.',
    }
  }

  const tree: string[] = []
  await walkTree(root, root, tree, 0)
  const keyFiles = await readKeyFiles(root)
  const codegraph = await tryCodegraphSummary(root, opts.epicHint || '')

  const parts = [
    '## Repository file tree (sampled)',
    tree.length ? tree.map((t) => `- ${t}`).join('\n') : '- (empty or unreadable)',
    '',
    '## Key files',
    keyFiles.length ? keyFiles.join('\n\n') : '_No standard manifest/README found._',
  ]

  if (codegraph) {
    parts.push('', '## CodeGraph explore (live)', '```', codegraph, '```')
  }

  let summary = parts.join('\n')
  if (summary.length > MAX_CONTEXT_CHARS) {
    summary = `${summary.slice(0, MAX_CONTEXT_CHARS)}\n\n…(truncated)`
  }

  return { available: true, summary }
}
