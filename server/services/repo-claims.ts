import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '#utils/db'

export const claimRepoSchema = z.object({
  forgeType: z.enum(['github', 'gitlab']),
  fullName: z.string().min(1).max(512),
  holder: z.string().min(1).max(256),
  ttlSeconds: z.number().int().min(1).max(300).default(10),
  taskType: z.string().min(1).max(64).optional(),
  externalId: z.string().min(1).max(64).optional(),
})

export type ClaimRepoInput = z.infer<typeof claimRepoSchema>

export function repoClaimLockKey(forgeType: 'github' | 'gitlab', fullName: string): string {
  return `${forgeType}:${fullName.trim().replace(/^\/+|\/+$/g, '').toLowerCase()}`
}

type ClaimRow = {
  lock_key: string
  holder: string
  expires_at: Date | string
}

function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows[0]
  }
  // drizzle RowList is array-like
  if (result && typeof result === 'object' && '0' in (result as object)) {
    return (result as { 0: T })[0]
  }
  return undefined
}

/**
 * Atomically claim a repository for a short TTL.
 * Succeeds when the key is free, expired, or already held by the same holder (renew).
 */
export async function tryClaimRepo(input: ClaimRepoInput): Promise<{
  claimed: boolean
  lockKey: string
  holder: string | null
  expiresAt: string | null
}> {
  const parsed = claimRepoSchema.parse(input)
  const lockKey = repoClaimLockKey(parsed.forgeType, parsed.fullName)
  const ttlSeconds = parsed.ttlSeconds
  const db = getDb()

  const inserted = await db.execute(sql`
    INSERT INTO worker_repo_claims (
      lock_key,
      holder,
      expires_at,
      forge_type,
      full_name,
      task_type,
      external_id,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${lockKey},
      ${parsed.holder},
      now() + make_interval(secs => ${ttlSeconds}),
      ${parsed.forgeType}::forge_type,
      ${parsed.fullName},
      ${parsed.taskType ?? null},
      ${parsed.externalId ?? null},
      '{}'::jsonb,
      now(),
      now()
    )
    ON CONFLICT (lock_key) DO UPDATE SET
      holder = EXCLUDED.holder,
      expires_at = EXCLUDED.expires_at,
      forge_type = EXCLUDED.forge_type,
      full_name = EXCLUDED.full_name,
      task_type = EXCLUDED.task_type,
      external_id = EXCLUDED.external_id,
      updated_at = now()
    WHERE worker_repo_claims.expires_at < now()
       OR worker_repo_claims.holder = EXCLUDED.holder
    RETURNING lock_key, holder, expires_at
  `)

  const row = firstRow<ClaimRow>(inserted)
  if (row) {
    return {
      claimed: true,
      lockKey: String(row.lock_key),
      holder: String(row.holder),
      expiresAt: new Date(row.expires_at).toISOString(),
    }
  }

  const current = await db.execute(sql`
    SELECT holder, expires_at FROM worker_repo_claims WHERE lock_key = ${lockKey} LIMIT 1
  `)
  const cur = firstRow<ClaimRow>(current)
  return {
    claimed: false,
    lockKey,
    holder: cur?.holder ? String(cur.holder) : null,
    expiresAt: cur?.expires_at ? new Date(cur.expires_at).toISOString() : null,
  }
}
