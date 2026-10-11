import { readBody, getHeader } from 'h3'
import { z } from 'zod'
import { handleApi } from '#utils/api'
import { upsertTaskRunFromWorker } from '#services/tasks'
import { AppError } from '#utils/errors'
import { safeEqual } from '#utils/crypto'

const schema = z.object({
  repositoryName: z.string().optional(),
  forgeType: z.enum(['github', 'gitlab']),
  taskType: z.enum(['github_issue', 'gitlab_issue', 'github_pr_implement', 'gitlab_mr_implement', 'github_pr_review', 'gitlab_mr_review', 'release']),
  externalId: z.string(),
  externalUrl: z.string().optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  status: z.enum(['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  errorSummary: z.string().optional(),
  resultMetadata: z.record(z.unknown()).optional(),
  logPath: z.string().optional(),
  correlationId: z.string().optional(),
})

export default defineEventHandler((event) => handleApi(event, async () => {
  const token = getHeader(event, 'x-worker-token') || ''
  const expected = process.env.WORKER_INTERNAL_TOKEN || ''
  if (!expected || !safeEqual(token, expected)) {
    throw new AppError(401, 'Unauthorized', 'unauthorized')
  }
  return upsertTaskRunFromWorker(schema.parse(await readBody(event)))
}))
