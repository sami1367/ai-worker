import { getSessionUser } from '#services/auth'
import { getTaskQueue } from '#services/task-queue'
import { subscribeQueueEvents } from '#services/queue-events'
import { SESSION_COOKIE } from '#utils/session'

type PeerState = {
  unsubscribe?: () => void
  pingTimer?: ReturnType<typeof setInterval>
  authed?: boolean
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=')
    if (rawKey === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function peerCookieHeader(peer: { request?: { headers?: Headers | Record<string, string> }, headers?: Record<string, string> }): string | undefined {
  const headers = peer.request?.headers || peer.headers
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('cookie') || undefined
  }
  const rec = headers as Record<string, string>
  return rec.cookie || rec.Cookie
}

async function sendQueue(peer: { send: (data: string) => void }, reason: string) {
  try {
    const queue = await getTaskQueue()
    peer.send(JSON.stringify({ type: 'queue', reason, at: new Date().toISOString(), queue }))
  } catch (err) {
    peer.send(JSON.stringify({
      type: 'error',
      message: err instanceof Error ? err.message : 'queue snapshot failed',
    }))
  }
}

/**
 * WebSocket live queue at /ws/tasks-queue (Nitro crossws).
 * Auth via session cookie. Pushes DB-backed snapshots on queue changes.
 */
export default defineWebSocketHandler({
  async open(peer) {
    const state = peer.context as PeerState
    const sessionId = readCookie(peerCookieHeader(peer), SESSION_COOKIE)
    const user = await getSessionUser(sessionId)
    if (!user) {
      peer.send(JSON.stringify({ type: 'error', message: 'Authentication required' }))
      peer.close(4401, 'Unauthorized')
      return
    }
    state.authed = true
    await sendQueue(peer, 'subscribe')
    state.unsubscribe = subscribeQueueEvents((evt) => {
      if (evt.type === 'queue_updated') {
        void sendQueue(peer, evt.reason)
      }
    })
    state.pingTimer = setInterval(() => {
      try {
        peer.send(JSON.stringify({ type: 'ping', at: new Date().toISOString() }))
      } catch {
        /* closed */
      }
    }, 20_000)
  },
  close(peer) {
    const state = peer.context as PeerState
    if (state.pingTimer) clearInterval(state.pingTimer)
    state.unsubscribe?.()
  },
  error(peer) {
    const state = peer.context as PeerState
    if (state.pingTimer) clearInterval(state.pingTimer)
    state.unsubscribe?.()
  },
})
