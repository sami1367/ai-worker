import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { getTaskQueue } from '#services/task-queue'
import { subscribeQueueEvents } from '#services/queue-events'

/**
 * SSE live queue stream. Pushes full DB-backed snapshots when the queue changes
 * (forge sync, webhook, heartbeat assignment, task run upsert).
 */
export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setHeader(event, 'Connection', 'keep-alive')
  setHeader(event, 'X-Accel-Buffering', 'no')

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const send = (payload: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          closed = true
        }
      }

      const pushSnapshot = async (reason: string) => {
        try {
          const queue = await getTaskQueue()
          send({ type: 'queue', reason, at: new Date().toISOString(), queue })
        } catch (err) {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : 'queue snapshot failed',
          })
        }
      }

      await pushSnapshot('subscribe')

      const unsubscribe = subscribeQueueEvents((evt) => {
        if (evt.type === 'queue_updated') {
          void pushSnapshot(evt.reason)
        }
      })

      const pingTimer = setInterval(() => {
        send({ type: 'ping', at: new Date().toISOString() })
      }, 20_000)

      const onClose = () => {
        if (closed) return
        closed = true
        clearInterval(pingTimer)
        unsubscribe()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      event.node.req.on('close', onClose)
      event.node.req.on('aborted', onClose)
    },
  })

  return stream
}))
