import type { EventEmitter } from 'node:events'
import { EventEmitter as NodeEventEmitter } from 'node:events'

export type QueueEvent =
  | { type: 'queue_updated', reason: string, at: string }
  | { type: 'ping', at: string }

const bus: EventEmitter = new NodeEventEmitter()
bus.setMaxListeners(100)

export function publishQueueUpdated(reason: string) {
  const event: QueueEvent = {
    type: 'queue_updated',
    reason,
    at: new Date().toISOString(),
  }
  bus.emit('queue', event)
}

export function subscribeQueueEvents(listener: (event: QueueEvent) => void): () => void {
  bus.on('queue', listener)
  return () => {
    bus.off('queue', listener)
  }
}
