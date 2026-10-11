import { handleApi } from '#utils/api'
import { requireUser } from '#utils/session'
import { streamTaskLog } from '#services/tasks'

export default defineEventHandler((event) => handleApi(event, async () => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setHeader(event, 'Connection', 'keep-alive')

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }
      const ac = new AbortController()
      event.node.req.on('close', () => ac.abort())
      try {
        for await (const msg of streamTaskLog(id, ac.signal)) {
          send(msg)
          if (msg.type === 'done' || msg.type === 'error') break
        }
      } catch (err) {
        send({ type: 'error', message: 'stream failed' })
      } finally {
        controller.close()
      }
    },
  })
  return stream
}))
