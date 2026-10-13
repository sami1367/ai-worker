import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { workerBaseDir } from '#utils/paths'
import { AppError } from '#utils/errors'

const execFileAsync = promisify(execFile)

const KEY_NAME = 'id_ed25519'
const DEFAULT_COMMENT = 'ai-worker-platform'

export function platformSshDir(base = workerBaseDir()): string {
  return join(base, 'ssh')
}

export function platformSshPrivateKeyPath(base = workerBaseDir()): string {
  return join(platformSshDir(base), KEY_NAME)
}

export function platformSshPublicKeyPath(base = workerBaseDir()): string {
  return `${platformSshPrivateKeyPath(base)}.pub`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function hardenPermissions(dir: string, privateKey: string, publicKey: string) {
  try { await chmod(dir, 0o700) } catch { /* best-effort */ }
  try { await chmod(privateKey, 0o600) } catch { /* best-effort */ }
  try { await chmod(publicKey, 0o644) } catch { /* best-effort */ }
}

/**
 * Ensure a single shared ed25519 keypair exists on the data volume.
 * Private key is never returned. Idempotent across web + workers.
 */
export async function ensurePlatformSshKey(opts?: {
  baseDir?: string
  comment?: string
}): Promise<{ created: boolean, publicKeyPath: string, privateKeyPath: string }> {
  const base = opts?.baseDir ?? workerBaseDir()
  const dir = platformSshDir(base)
  const privateKeyPath = platformSshPrivateKeyPath(base)
  const publicKeyPath = platformSshPublicKeyPath(base)
  const comment = opts?.comment
    || process.env.AI_WORKER_SSH_KEY_COMMENT
    || DEFAULT_COMMENT

  await mkdir(dir, { recursive: true, mode: 0o700 })

  if (await pathExists(privateKeyPath) && await pathExists(publicKeyPath)) {
    await hardenPermissions(dir, privateKeyPath, publicKeyPath)
    return { created: false, publicKeyPath, privateKeyPath }
  }

  const tmpBase = join(dir, `.${KEY_NAME}.${process.pid}.${Date.now()}`)
  const tmpKey = tmpBase
  const tmpPub = `${tmpBase}.pub`

  try {
    await execFileAsync('ssh-keygen', [
      '-q',
      '-t', 'ed25519',
      '-N', '',
      '-C', comment,
      '-f', tmpKey,
    ], { timeout: 30_000 })
  } catch (err) {
    await rm(tmpKey, { force: true }).catch(() => {})
    await rm(tmpPub, { force: true }).catch(() => {})
    throw new AppError(
      500,
      `Failed to generate platform SSH key: ${err instanceof Error ? err.message : String(err)}`,
      'ssh_keygen_failed',
    )
  }

  await chmod(tmpKey, 0o600).catch(() => {})
  await chmod(tmpPub, 0o644).catch(() => {})

  // Race-tolerant publish: keep the first writer’s key.
  if (!(await pathExists(privateKeyPath))) {
    await rename(tmpKey, privateKeyPath)
  } else {
    await rm(tmpKey, { force: true }).catch(() => {})
  }
  if (!(await pathExists(publicKeyPath))) {
    await rename(tmpPub, publicKeyPath)
  } else {
    await rm(tmpPub, { force: true }).catch(() => {})
  }

  await hardenPermissions(dir, privateKeyPath, publicKeyPath)
  return { created: true, publicKeyPath, privateKeyPath }
}

export async function getPlatformSshPublicKeyInfo(opts?: { baseDir?: string }) {
  const ensured = await ensurePlatformSshKey(opts)
  const publicKey = (await readFile(ensured.publicKeyPath, 'utf8')).trim()
  if (!publicKey.startsWith('ssh-')) {
    throw new AppError(500, 'Platform SSH public key is invalid', 'ssh_pubkey_invalid')
  }

  let fingerprint = ''
  let keyType = 'ed25519'
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-lf', ensured.publicKeyPath], {
      timeout: 10_000,
    })
    // e.g. "256 SHA256:abcd… ai-worker-platform (ED25519)"
    fingerprint = stdout.trim().split(/\s+/)[1] || ''
    const typeMatch = stdout.match(/\(([^)]+)\)\s*$/)
    if (typeMatch?.[1]) keyType = typeMatch[1].toLowerCase()
  } catch {
    fingerprint = ''
  }

  return {
    publicKey,
    fingerprint,
    keyType,
    comment: publicKey.split(/\s+/)[2] || DEFAULT_COMMENT,
    privateKeyPath: ensured.privateKeyPath,
    // Never include private key material
    privateKeyPresent: await pathExists(ensured.privateKeyPath),
    createdJustNow: ensured.created,
  }
}

/** Path helper used by workspace-manager (null if missing). Does not generate. */
export async function platformSshKeyPathIfPresent(base = workerBaseDir()): Promise<string | null> {
  const key = platformSshPrivateKeyPath(base)
  return (await pathExists(key)) ? key : null
}
