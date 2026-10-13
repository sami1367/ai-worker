import { and, count, desc, eq, gt, sql } from 'drizzle-orm'
import { loginAttempts, sessions, users } from '#db/schema'
import { AppError } from '#utils/errors'
import { getDb } from '#utils/db'
import { hashPassword, newSessionId, safeEqual, verifyPassword } from '#utils/crypto'
import { isInsecureSecret, SECRET_MIN_LENGTHS } from '#utils/app-secrets'
import { writeAudit } from './audit'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7
const MAX_FAILED_ATTEMPTS = 10
const WINDOW_MS = 1000 * 60 * 15

export async function countUsers(): Promise<number> {
  const db = getDb()
  const [row] = await db.select({ c: count() }).from(users)
  return row?.c ?? 0
}

export async function bootstrapAdmin(opts: {
  username: string
  password: string
  bootstrapSecret: string
  expectedSecret: string
  ipHash?: string
}) {
  if (
    !opts.expectedSecret
    || isInsecureSecret(opts.expectedSecret, SECRET_MIN_LENGTHS.INITIAL_ADMIN_BOOTSTRAP_SECRET)
  ) {
    throw new AppError(
      503,
      'Bootstrap secret is not configured securely',
      'bootstrap_misconfigured',
    )
  }
  if (!safeEqual(opts.bootstrapSecret, opts.expectedSecret)) {
    throw new AppError(403, 'Invalid bootstrap secret', 'bootstrap_forbidden')
  }
  if ((await countUsers()) > 0) {
    throw new AppError(409, 'Administrator already exists', 'bootstrap_exists')
  }
  if (opts.password.length < 12) {
    throw new AppError(400, 'Password must be at least 12 characters', 'weak_password')
  }
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(opts.username)) {
    throw new AppError(400, 'Invalid username', 'invalid_username')
  }

  const db = getDb()
  const passwordHash = await hashPassword(opts.password)
  const [user] = await db.insert(users).values({
    username: opts.username,
    passwordHash,
    role: 'admin',
    isActive: true,
  }).returning()

  await writeAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'auth.bootstrap_admin',
    targetType: 'user',
    targetId: user.id,
    ipHash: opts.ipHash,
  })

  return { id: user.id, username: user.username, role: user.role }
}

async function assertNotRateLimited(username: string, ipHash: string) {
  const db = getDb()
  const since = new Date(Date.now() - WINDOW_MS)
  const [byUser] = await db.select({ c: count() }).from(loginAttempts).where(and(
    eq(loginAttempts.username, username),
    eq(loginAttempts.succeeded, false),
    gt(loginAttempts.createdAt, since),
  ))
  const [byIp] = await db.select({ c: count() }).from(loginAttempts).where(and(
    eq(loginAttempts.ipHash, ipHash),
    eq(loginAttempts.succeeded, false),
    gt(loginAttempts.createdAt, since),
  ))
  if ((byUser?.c ?? 0) >= MAX_FAILED_ATTEMPTS || (byIp?.c ?? 0) >= MAX_FAILED_ATTEMPTS) {
    throw new AppError(429, 'Too many login attempts. Try again later.', 'rate_limited')
  }
}

export async function login(opts: {
  username: string
  password: string
  ipHash: string
  userAgent?: string
}) {
  await assertNotRateLimited(opts.username, opts.ipHash)
  const db = getDb()

  const [user] = await db.select().from(users).where(eq(users.username, opts.username)).limit(1)
  const ok = user && user.isActive ? await verifyPassword(user.passwordHash, opts.password) : false

  await db.insert(loginAttempts).values({
    username: opts.username,
    ipHash: opts.ipHash,
    succeeded: ok,
  })

  if (!ok || !user) {
    await writeAudit({
      actorUsername: opts.username,
      action: 'auth.login_failed',
      ipHash: opts.ipHash,
    })
    throw new AppError(401, 'Invalid username or password', 'invalid_credentials')
  }

  // Session rotation: create new session id
  const sessionId = newSessionId()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    expiresAt,
    ipHash: opts.ipHash,
    userAgent: opts.userAgent?.slice(0, 512),
  })
  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id))

  await writeAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'auth.login',
    targetType: 'user',
    targetId: user.id,
    ipHash: opts.ipHash,
  })

  return {
    sessionId,
    expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  }
}

export async function logout(sessionId: string | undefined, actor?: { id: string, username: string }, ipHash?: string) {
  if (!sessionId) return
  const db = getDb()
  await db.delete(sessions).where(eq(sessions.id, sessionId))
  if (actor) {
    await writeAudit({
      actorUserId: actor.id,
      actorUsername: actor.username,
      action: 'auth.logout',
      ipHash,
    })
  }
}

export async function getSessionUser(sessionId: string | undefined) {
  if (!sessionId) return null
  const db = getDb()
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1)

  if (!row || !row.isActive || row.expiresAt.getTime() < Date.now()) {
    if (row) await db.delete(sessions).where(eq(sessions.id, sessionId))
    return null
  }

  return {
    sessionId: row.sessionId,
    id: row.userId,
    username: row.username,
    role: row.role as 'admin' | 'operator',
  }
}

export async function changePassword(opts: {
  userId: string
  currentPassword: string
  newPassword: string
  ipHash?: string
}) {
  if (opts.newPassword.length < 12) {
    throw new AppError(400, 'Password must be at least 12 characters', 'weak_password')
  }
  const db = getDb()
  const [user] = await db.select().from(users).where(eq(users.id, opts.userId)).limit(1)
  if (!user) throw new AppError(404, 'User not found', 'not_found')
  const ok = await verifyPassword(user.passwordHash, opts.currentPassword)
  if (!ok) throw new AppError(401, 'Invalid username or password', 'invalid_credentials')

  const passwordHash = await hashPassword(opts.newPassword)
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, user.id))
  // Invalidate all sessions
  await db.delete(sessions).where(eq(sessions.userId, user.id))

  await writeAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'auth.password_change',
    targetType: 'user',
    targetId: user.id,
    ipHash: opts.ipHash,
  })
}

export async function setupStatus() {
  const total = await countUsers()
  return {
    needsSetup: total === 0,
    hasUsers: total > 0,
  }
}
