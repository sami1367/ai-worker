import { handleApi, clientIpHash, requireRole } from '#utils/api'
import { requireUser } from '#utils/session'
import { getRepository } from '#services/repositories'
import { ensureRepositoryLabels, AI_WORKER_LABELS } from '#services/ai-labels'
import { writeAudit } from '#services/audit'
import { AppError } from '#utils/errors'

export default defineEventHandler((event) => handleApi(event, async () => {
  const user = await requireUser(event)
  requireRole('admin', user.role)
  const id = getRouterParam(event, 'id')!
  const repo = await getRepository(id)

  try {
    const result = await ensureRepositoryLabels(id, { strict: true })
    await writeAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'repository.setup_labels',
      targetType: 'repository',
      targetId: id,
      metadata: {
        forgeType: repo.forgeType,
        ok: true,
        ensured: result.ensured,
        labels: AI_WORKER_LABELS.map((l) => l.name),
      },
      ipHash: clientIpHash(event),
    })
    return {
      ok: true,
      ensured: result.ensured,
      labels: AI_WORKER_LABELS.map((l) => l.name),
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await writeAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'repository.setup_labels_failed',
      targetType: 'repository',
      targetId: id,
      metadata: { message: message.slice(0, 500) },
      ipHash: clientIpHash(event),
    })
    if (err instanceof AppError) throw err
    throw new AppError(500, 'Label setup failed. Check forge connection credentials and repository permissions.', 'setup_labels_failed')
  }
}))
