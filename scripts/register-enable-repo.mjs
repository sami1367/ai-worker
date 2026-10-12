#!/usr/bin/env node
/**
 * One-shot: register a discovered forge repo, clone workspace, enable for worker.
 * Usage (inside web container):
 *   node /app/scripts/register-enable-repo.mjs sami1367/vibe-plus1-user
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { mkdir, rename, writeFile, access, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import postgres from 'postgres'

const execFileAsync = promisify(execFile)
const FULL_NAME = process.argv[2]
if (!FULL_NAME) {
  console.error('Usage: node register-enable-repo.mjs <owner/repo> [--block-on-open-pr=true|false] [--name=short-name]')
  process.exit(1)
}
const argValue = (prefix, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(prefix))
  if (!hit) return fallback
  return hit.slice(prefix.length)
}
const BLOCK_ON_OPEN_PR = argValue('--block-on-open-pr=', 'true') !== 'false'
const FORCE_NAME = argValue('--name=', '')

const DATABASE_URL = process.env.DATABASE_URL
const KEY = process.env.SECRET_ENCRYPTION_KEY
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/data/workspaces'
const CONFIG_DIR = process.env.AI_WORKER_BASE_DIR || process.env.CONFIG_DIR || '/data/config'

if (!DATABASE_URL || !KEY) {
  console.error('DATABASE_URL and SECRET_ENCRYPTION_KEY are required')
  process.exit(1)
}

function encryptionKeyBytes(keyMaterial) {
  if (/^[0-9a-fA-F]{64}$/.test(keyMaterial)) return Buffer.from(keyMaterial, 'hex')
  return createHash('sha256').update(keyMaterial).digest()
}

function decryptSecret(ciphertext, keyMaterial) {
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format')
  const [, ivB64, tagB64, dataB64] = parts
  const key = encryptionKeyBytes(keyMaterial)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

function newWorkspaceId() {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)
}

function authenticatedCloneUrl(remoteUrl, token, forgeType, instanceUrl) {
  if (forgeType === 'gitlab') {
    // Prefer SSH: some self-hosted GitLab instances disable HTTP git access.
    const https = remoteUrl.replace(/\.git$/, '') + '.git'
    try {
      const u = new URL(https)
      const host = instanceUrl ? new URL(instanceUrl).host : u.host
      const path = u.pathname.replace(/^\//, '')
      return `git@${host}:${path}`
    } catch {
      // fall through to HTTPS token auth
    }
  }
  if (!token) return remoteUrl
  if (forgeType === 'github') {
    return remoteUrl.replace(/^https:\/\//i, `https://x-access-token:${token}@`)
  }
  return remoteUrl.replace(/^https:\/\//i, `https://oauth2:${token}@`)
}

async function atomicWriteJson(targetPath, data) {
  await mkdir(join(targetPath, '..'), { recursive: true }).catch(() => {})
  await mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, targetPath)
}

async function runGit(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      timeout: opts.timeoutMs || 300_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || e.message || 'git failed'),
    }
  }
}

const sql = postgres(DATABASE_URL, { max: 1 })

try {
  const [disc] = await sql`
    SELECT d.*, c.provider, c.instance_url, c.access_token_ciphertext, c.status AS connection_status
    FROM discovered_repositories d
    JOIN forge_connections c ON c.id = d.connection_id
    WHERE d.full_name = ${FULL_NAME}
    LIMIT 1
  `
  if (!disc) throw new Error(`Discovered repo not found: ${FULL_NAME}`)
  if (disc.connection_status === 'disconnected') throw new Error('Connection is disconnected')
  if (!disc.access_token_ciphertext) throw new Error('Connection has no access token')

  const [existing] = await sql`
    SELECT * FROM repositories
    WHERE forge_type = ${disc.provider}
      AND provider_repo_id = ${disc.provider_repo_id}
      AND instance_url = ${disc.instance_url}
      AND is_archived = false
    LIMIT 1
  `

  let repo = existing
  if (!repo) {
    const workspaceId = newWorkspaceId()
    const localPath = join(WORKSPACE_ROOT, workspaceId)
    const name = (FORCE_NAME || FULL_NAME.split('/').filter(Boolean).pop()).slice(0, 128)
    const [row] = await sql`
      INSERT INTO repositories (
        name, forge_type, remote_url, canonical_project_identifier,
        workspace_id, local_path, default_branch, is_enabled, block_on_open_pr,
        connection_id, discovered_repository_id, provider_repo_id, instance_url,
        visibility, workspace_status
      ) VALUES (
        ${name}, ${disc.provider}, ${disc.clone_url_https}, ${disc.full_name},
        ${workspaceId}, ${localPath}, ${disc.default_branch || 'main'}, false, ${BLOCK_ON_OPEN_PR},
        ${disc.connection_id}, ${disc.id}, ${disc.provider_repo_id}, ${disc.instance_url},
        ${disc.visibility}, 'queued'
      )
      RETURNING *
    `
    repo = row
    console.log(`registered ${FULL_NAME} as ${repo.id} (name=${name}, block_on_open_pr=${BLOCK_ON_OPEN_PR})`)
  } else {
    await sql`
      UPDATE repositories SET
        block_on_open_pr = ${BLOCK_ON_OPEN_PR},
        name = COALESCE(NULLIF(${FORCE_NAME}, ''), name),
        updated_at = now()
      WHERE id = ${existing.id}
    `
    const [refreshed] = await sql`SELECT * FROM repositories WHERE id = ${existing.id}`
    repo = refreshed
    console.log(`already registered ${FULL_NAME} as ${repo.id} (status=${repo.workspace_status}, block_on_open_pr=${BLOCK_ON_OPEN_PR})`)
  }

  const token = decryptSecret(disc.access_token_ciphertext, KEY)
  const path = repo.local_path || join(WORKSPACE_ROOT, repo.workspace_id)
  // Ensure SSH key is available for GitLab clones inside this one-shot too.
  if (disc.provider === 'gitlab') {
    process.env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND
      || `ssh -i ${CONFIG_DIR}/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
  }
  const authUrl = authenticatedCloneUrl(repo.remote_url, token, disc.provider, disc.instance_url)

  await sql`
    UPDATE repositories SET workspace_status = 'cloning', updated_at = now()
    WHERE id = ${repo.id}
  `

  let hasGit = false
  try {
    await access(join(path, '.git'))
    hasGit = true
  } catch {
    hasGit = false
  }

  if (!hasGit) {
    try {
      const st = await stat(path)
      if (st.isDirectory()) await rm(path, { recursive: true, force: true })
    } catch {
      // missing ok
    }
    await mkdir(WORKSPACE_ROOT, { recursive: true })
    console.log(`cloning into ${path}`)
    let result = await runGit([
      'clone', '--branch', repo.default_branch || 'main', '--single-branch', authUrl, path,
    ])
    if (result.code !== 0) {
      console.warn('branch clone failed, retrying without branch pin')
      result = await runGit(['clone', authUrl, path])
    }
    if (result.code !== 0) {
      throw new Error(`Clone failed: ${result.stderr || result.stdout}`)
    }
    // Keep SSH remotes for GitLab (HTTP git may be disabled). Strip embedded HTTPS tokens for GitHub.
    const cleanOrigin = disc.provider === 'gitlab' ? authUrl : repo.remote_url
    await runGit(['-C', path, 'remote', 'set-url', 'origin', cleanOrigin])
  } else {
    console.log('workspace already present; fetching')
    if (disc.provider === 'gitlab') {
      await runGit(['-C', path, 'remote', 'set-url', 'origin', authUrl])
    }
    await runGit(['-C', path, 'fetch', '--all', '--prune'], { timeoutMs: 180_000 })
  }

  await sql`
    UPDATE repositories SET
      local_path = ${path},
      workspace_status = 'ready',
      is_enabled = true,
      last_clone_at = now(),
      last_sync_at = now(),
      last_error = null,
      updated_at = now()
    WHERE id = ${repo.id}
  `

  const enabled = await sql`
    SELECT name, forge_type, local_path, block_on_open_pr
    FROM repositories
    WHERE is_enabled = true AND is_archived = false AND local_path IS NOT NULL
  `
  const github = []
  const gitlab = []
  for (const row of enabled) {
    const entry = {
      name: row.name,
      path: row.local_path,
      block_on_open_pr: row.block_on_open_pr,
    }
    if (row.forge_type === 'github') github.push(entry)
    else gitlab.push(entry)
  }
  await atomicWriteJson(join(CONFIG_DIR, 'github-projects.conf'), github)
  await atomicWriteJson(join(CONFIG_DIR, 'gitlab-projects.conf'), gitlab)

  try {
    await sql`UPDATE settings SET config_version = COALESCE(config_version, 0) + 1, updated_at = now()`
  } catch {
    console.warn('config_version bump skipped')
  }

  // Prefer forge tokens from connections used by enabled repos (Bash worker is single-token).
  const [ghConn] = await sql`
    SELECT c.access_token_ciphertext
    FROM repositories r
    JOIN forge_connections c ON c.id = r.connection_id
    WHERE r.is_enabled = true AND r.is_archived = false AND r.forge_type = 'github'
      AND c.status = 'active' AND c.access_token_ciphertext IS NOT NULL
    ORDER BY r.updated_at DESC
    LIMIT 1
  `
  const [glConn] = await sql`
    SELECT c.access_token_ciphertext, c.instance_url
    FROM repositories r
    JOIN forge_connections c ON c.id = r.connection_id
    WHERE r.is_enabled = true AND r.is_archived = false AND r.forge_type = 'gitlab'
      AND c.status = 'active' AND c.access_token_ciphertext IS NOT NULL
    ORDER BY r.updated_at DESC
    LIMIT 1
  `
  const lines = [
    '# Generated by AI Worker Platform — do not edit. Mode 0600.',
    '# Sourced by the worker entrypoint. Never commit this file.',
  ]
  if (ghConn?.access_token_ciphertext) {
    const tok = decryptSecret(ghConn.access_token_ciphertext, KEY)
    const q = `'${tok.replace(/'/g, `'\\''`)}'`
    lines.push(`export GH_TOKEN=${q}`, `export GITHUB_TOKEN=${q}`)
  } else {
    lines.push('# GH_TOKEN unset', '# GITHUB_TOKEN unset')
  }
  if (glConn?.access_token_ciphertext) {
    const tok = decryptSecret(glConn.access_token_ciphertext, KEY)
    const q = `'${tok.replace(/'/g, `'\\''`)}'`
    let host = 'gitlab.com'
    try { host = new URL(glConn.instance_url).host } catch { host = String(glConn.instance_url || '').replace(/^https?:\/\//, '') }
    lines.push(`export GITLAB_TOKEN=${q}`, `export GITLAB_HOST=${`'${host.replace(/'/g, `'\\''`)}'`}`)
  } else {
    lines.push('# GITLAB_TOKEN unset', '# GITLAB_HOST unset')
  }
  lines.push('')
  const credPath = join(CONFIG_DIR, 'forge-credentials.env')
  const credTmp = `${credPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(credTmp, lines.join('\n'), { mode: 0o600 })
  await rename(credTmp, credPath)

  console.log(JSON.stringify({
    ok: true,
    repositoryId: repo.id,
    fullName: FULL_NAME,
    path,
    githubCount: github.length,
    gitlabCount: gitlab.length,
    gitlabHost: glConn ? (safeHost(glConn.instance_url)) : null,
  }, null, 2))
} finally {
  await sql.end({ timeout: 5 })
}

function safeHost(instanceUrl) {
  try { return new URL(instanceUrl).host } catch { return String(instanceUrl || '') }
}
