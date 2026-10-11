import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { getRepository } from '#services/repositories'
import { writeAudit } from '#services/audit'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { workerBaseDir } from '#utils/paths'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')!
  const repo = await getRepository(id)
  const base = workerBaseDir()
  const script = repo.forgeType === 'github'
    ? join(base, 'setup-labels.sh')
    : join(base, 'setup-gitlab-labels.sh')

  // Fixed executable path only — never accept user-supplied command
  try {
    const { stdout, stderr } = await execFileAsync('bash', [script], {
      cwd: base,
      timeout: 120000,
      env: { ...process.env, AI_WORKER_BASE_DIR: base },
    })
    await writeAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'repository.setup_labels',
      targetType: 'repository',
      targetId: id,
      metadata: { forgeType: repo.forgeType, ok: true },
      ipHash: clientIpHash(event),
    })
    return { ok: true, stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) }
  } catch (err: any) {
    await writeAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'repository.setup_labels_failed',
      targetType: 'repository',
      targetId: id,
      metadata: { message: String(err?.message || err).slice(0, 500) },
      ipHash: clientIpHash(event),
    })
    throw createError({
      statusCode: 500,
      statusMessage: 'Label setup failed',
      data: { code: 'setup_labels_failed', message: 'Label setup failed. Check worker credentials and repository registration.' },
    })
  }
}))
