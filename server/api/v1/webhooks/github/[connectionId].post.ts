import { getHeader, getRouterParam, readRawBody } from 'h3'
import { handleApi } from '#utils/api'
import { handleGitHubWebhook } from '#services/webhooks'

export default defineEventHandler((event) => handleApi(event, async () => {
  const connectionId = getRouterParam(event, 'connectionId')!
  const rawBody = await readRawBody(event, false)
  if (!rawBody) {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }

  const payload = JSON.parse(
    Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody),
  ) as Record<string, unknown>

  const result = await handleGitHubWebhook({
    connectionId,
    eventName: getHeader(event, 'x-github-event') || undefined,
    signature: getHeader(event, 'x-hub-signature-256') || undefined,
    rawBody,
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
