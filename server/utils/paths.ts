import { createHash } from 'node:crypto'
import { join, normalize, resolve, sep } from 'node:path'

const FORBIDDEN_REMOTE_PATTERNS = [
  /^file:/i,
  /^git:\/\//i,
  /^ext::/i,
  /^ssh:\/\/[^/]*@/i, // allow ssh://host but we'll validate schemes separately
]

export function workspaceRootFromEnv(): string {
  return process.env.WORKSPACE_ROOT || '/data/workspaces'
}

export function managedWorkspacePath(workspaceId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
    throw new Error('Invalid workspace id')
  }
  const root = resolve(workspaceRootFromEnv())
  const full = resolve(join(root, workspaceId))
  if (!full.startsWith(root + sep) && full !== root) {
    throw new Error('Workspace path escape detected')
  }
  return full
}

export function newWorkspaceId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)
}

export function validateRemoteUrl(url: string): { ok: true; normalized: string } | { ok: false; reason: string } {
  const trimmed = url.trim()
  if (!trimmed) return { ok: false, reason: 'Remote URL is required' }
  if (trimmed.includes('://') && /\/\/[^/]*:[^@/]+@/.test(trimmed)) {
    return { ok: false, reason: 'Embedded credentials in remote URLs are not allowed' }
  }
  if (trimmed.includes('..')) {
    return { ok: false, reason: 'Path traversal is not allowed in remote URLs' }
  }
  for (const pat of FORBIDDEN_REMOTE_PATTERNS) {
    if (pat.test(trimmed) && !trimmed.startsWith('ssh://')) {
      return { ok: false, reason: 'Unsupported or unsafe remote URL scheme' }
    }
  }

  // Allow: https://, git@host:path, ssh://git@host/path
  if (
    /^https:\/\/[^\s]+$/i.test(trimmed)
    || /^git@[^\s:]+:[^\s]+$/i.test(trimmed)
    || /^ssh:\/\/git@[^\s]+$/i.test(trimmed)
  ) {
    return { ok: true, normalized: trimmed }
  }

  return { ok: false, reason: 'Remote URL must be https://, git@host:path, or ssh://git@host/...' }
}

export function resolveLogPath(logsDir: string, relativeOrName: string): string | null {
  const root = resolve(logsDir)
  // Allow basename or relative subpaths under logs that don't escape
  const full = resolve(root, normalize(relativeOrName).replace(/^(\.\.(\/|\\|$))+/, ''))
  if (!full.startsWith(root + sep) && full !== root) return null
  if (full.includes('\0')) return null
  return full
}

export function workerBaseDir(): string {
  return process.env.AI_WORKER_BASE_DIR
    || process.env.CONFIG_DIR
    || join(process.cwd(), 'worker')
}
