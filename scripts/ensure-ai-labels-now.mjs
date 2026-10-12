#!/usr/bin/env node
/**
 * One-shot: create missing AI work/review labels on all discovered forge projects.
 * Usage (inside web container): node /app/scripts/ensure-ai-labels-now.mjs
 * Optional: CONNECTION_ID=<uuid> to limit to one connection.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import postgres from 'postgres'

const LABELS = [
  { name: 'ai', color: '0E8A16', description: 'Queue this issue for the AI worker' },
  { name: 'ai-working', color: 'FBCA04', description: 'AI worker is currently processing this issue' },
  { name: 'ai-pr', color: '1D76DB', description: 'AI worker completed the issue and created a pull request' },
  { name: 'ai-failed', color: 'D73A4A', description: 'AI worker failed; review logs before retrying' },
  { name: 'ai-review', color: '7057FF', description: 'Queue this open pull request for an AI review comment' },
  { name: 'ai-reviewing', color: 'FBCA04', description: 'AI worker is currently reviewing this pull request' },
  { name: 'ai-reviewed', color: '0E8A16', description: 'AI review comment was posted on this pull request' },
  { name: 'ai-review-failed', color: 'D73A4A', description: 'AI PR review failed; review logs before retrying' },
]

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

function canManage(permissions, provider) {
  if (!permissions || typeof permissions !== 'object') return true
  if (provider === 'github') {
    if (permissions.admin === true || permissions.push === true) return true
    if (permissions.admin === false && permissions.push === false) return false
    return true
  }
  const level = typeof permissions.accessLevel === 'number' ? permissions.accessLevel : null
  if (level === null) return true
  return level >= 30
}

async function listGithubLabels(token, repo) {
  const names = new Set()
  let page = 1
  while (page <= 20) {
    const res = await fetch(`https://api.github.com/repos/${repo}/labels?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-worker-platform',
      },
    })
    if (!res.ok) throw new Error(`GitHub list labels ${repo}: ${res.status} ${await res.text()}`)
    const batch = await res.json()
    for (const item of batch) names.add(String(item.name).toLowerCase())
    if (batch.length < 100) break
    page += 1
  }
  return names
}

async function ensureGithub(token, fullName) {
  const repo = fullName.replace(/\.git$/, '')
  const existing = await listGithubLabels(token, repo)
  let created = 0
  for (const label of LABELS) {
    if (existing.has(label.name.toLowerCase())) continue
    const res = await fetch(`https://api.github.com/repos/${repo}/labels`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-worker-platform',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: label.name,
        color: label.color,
        description: label.description,
      }),
    })
    if (res.ok || res.status === 422) {
      if (res.ok) created += 1
      continue
    }
    throw new Error(`GitHub create ${label.name} on ${repo}: ${res.status} ${await res.text()}`)
  }
  return created
}

async function listGitlabLabels(instanceUrl, token, projectPath) {
  const base = instanceUrl.replace(/\/+$/, '')
  const encoded = encodeURIComponent(projectPath)
  const names = new Set()
  let page = 1
  while (page <= 20) {
    const res = await fetch(`${base}/api/v4/projects/${encoded}/labels?per_page=100&page=${page}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'ai-worker-platform' },
    })
    if (!res.ok) throw new Error(`GitLab list labels ${projectPath}: ${res.status} ${await res.text()}`)
    const batch = await res.json()
    for (const item of batch) names.add(String(item.name).toLowerCase())
    if (batch.length < 100) break
    page += 1
  }
  return names
}

async function ensureGitlab(instanceUrl, token, projectPath) {
  const base = instanceUrl.replace(/\/+$/, '')
  const encoded = encodeURIComponent(projectPath)
  const existing = await listGitlabLabels(instanceUrl, token, projectPath)
  let created = 0
  for (const label of LABELS) {
    if (existing.has(label.name.toLowerCase())) continue
    const res = await fetch(`${base}/api/v4/projects/${encoded}/labels`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'ai-worker-platform',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: label.name,
        color: `#${label.color}`,
        description: label.description,
      }),
    })
    if (res.ok || res.status === 400 || res.status === 409) {
      if (res.ok) created += 1
      continue
    }
    throw new Error(`GitLab create ${label.name} on ${projectPath}: ${res.status} ${await res.text()}`)
  }
  return created
}

const databaseUrl = process.env.DATABASE_URL
const key = process.env.SECRET_ENCRYPTION_KEY
if (!databaseUrl || !key) {
  console.error('DATABASE_URL and SECRET_ENCRYPTION_KEY are required')
  process.exit(1)
}

const sql = postgres(databaseUrl, { max: 1 })
const onlyId = process.env.CONNECTION_ID || null

try {
  const connections = await sql`
    SELECT id, provider, instance_url, account_login, access_token_ciphertext, status
    FROM forge_connections
    WHERE status = 'active'
      AND access_token_ciphertext IS NOT NULL
      ${onlyId ? sql`AND id = ${onlyId}` : sql``}
    ORDER BY updated_at DESC
  `

  let totalCreated = 0
  let totalOk = 0
  let totalFail = 0

  for (const conn of connections) {
    const token = decryptSecret(conn.access_token_ciphertext, key)
    const repos = await sql`
      SELECT full_name, permissions
      FROM discovered_repositories
      WHERE connection_id = ${conn.id} AND is_archived = false
      ORDER BY full_name
    `
    console.log(`\n=== ${conn.provider} ${conn.account_login} (${repos.length} repos) ===`)

    for (const repo of repos) {
      if (!canManage(repo.permissions, conn.provider)) {
        console.log(`skip (no write): ${repo.full_name}`)
        continue
      }
      try {
        const created = conn.provider === 'github'
          ? await ensureGithub(token, repo.full_name)
          : await ensureGitlab(conn.instance_url, token, repo.full_name)
        totalOk += 1
        totalCreated += created
        console.log(`${created ? `created ${created}` : 'already ok'}: ${repo.full_name}`)
      } catch (err) {
        totalFail += 1
        console.error(`FAIL ${repo.full_name}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  console.log(`\nDone. repos_ok=${totalOk} repos_failed=${totalFail} labels_created=${totalCreated}`)
} finally {
  await sql.end({ timeout: 5 })
}
