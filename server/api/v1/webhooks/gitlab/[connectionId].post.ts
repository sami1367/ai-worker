import { getHeader, getRouterParam, readBody } from 'h3'
import { handleApi } from '#utils/api'
import { handleGitLabWebhook } from '#services/webhooks'

export default defineEventHandler((event) => handleApi(event, async () => {
  const connectionId = getRouterParam(event, 'connectionId')!
  const payload = await readBody(event) as Record<string, unknown>
  if (!payload || typeof payload !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }

  const result = await handleGitLabWebhook({
    connectionId,
    tokenHeader: getHeader(event, 'x-gitlab-token') || undefined,
    payload,
  })

  return {
    ok: true,
    wokeWorker: result.wokeWorker,
    kind: result.kind,
    action: result.action,
    labels: result.labels,
    externalId: result.externalId,
    repositoryFullName: result.repositoryFullName,
  }
}))
