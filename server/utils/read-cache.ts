import { createHash } from 'node:crypto'
import Redis from 'ioredis'

type Entry<T> = { value: T, freshUntil: number, staleUntil: number }
export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>
}

/** Short-lived read cache. No rejected promises or credentials are stored. */
export function createReadCache(store?: CacheStore, now = () => Date.now()) {
  const memory = new Map<string, Entry<unknown>>()
  const pending = new Map<string, Promise<unknown>>()
  function remember(key: string, entry: Entry<unknown>) {
    memory.delete(key)
    memory.set(key, entry)
    if (memory.size > 500) memory.delete(memory.keys().next().value!)
  }
  return async function cached<T>(key: string, load: () => Promise<T>, options: {
    ttlSeconds: number
    staleSeconds?: number
    coldValue?: () => T
  }): Promise<T> {
    const ttl = options.ttlSeconds
    const stale = options.staleSeconds || 0
    let entry = memory.get(key) as Entry<T> | undefined
    if (!entry && store) {
      try {
        const raw = await store.get(key)
        if (raw) {
          const parsed = JSON.parse(raw) as Entry<T>
          if (parsed && typeof parsed.freshUntil === 'number' && typeof parsed.staleUntil === 'number') {
            entry = parsed
            remember(key, entry)
          }
        }
      } catch { /* Redis is optional; use bounded process memory on failure. */ }
    }
    if (entry && now() < entry.freshUntil) return entry.value
    const refresh = () => {
      let job = pending.get(key) as Promise<T> | undefined
      if (!job) {
        job = Promise.resolve().then(load).then(async value => {
          const updated = { value, freshUntil: now() + ttl * 1000, staleUntil: now() + (ttl + stale) * 1000 }
          remember(key, updated)
          if (store) {
            try { await store.set(key, JSON.stringify(updated), ttl + stale) } catch { /* fallback already populated */ }
          }
          return value
        }).finally(() => pending.delete(key))
        pending.set(key, job)
      }
      return job
    }
    if (entry && now() < entry.staleUntil) {
      void refresh().catch(() => {})
      return entry.value
    }
    if (options.coldValue) {
      void refresh().catch(() => {})
      return options.coldValue()
    }
    return refresh()
  }
}

// Hash the complete identity (including credential revision) to isolate accounts
// without exposing tokens or account details in Redis key names.
export function readCacheKey(namespace: string, identity: unknown): string {
  return `ai-worker:reads:v1:${namespace}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

let cache: ReturnType<typeof createReadCache> | undefined
export function cachedRead<T>(key: string, load: () => Promise<T>, options: { ttlSeconds: number, staleSeconds?: number, coldValue?: () => T }): Promise<T> {
  if (!cache) {
    const url = process.env.REDIS_URL
    let store: CacheStore | undefined
    if (url) {
      const redis = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 300,
        commandTimeout: 400,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        retryStrategy: () => 5000,
      })
      redis.on('error', () => {})
      void redis.connect().catch(() => {})
      store = {
        get: key => redis.get(key),
        set: (key, value, ttl) => redis.set(key, value, 'EX', ttl),
      }
    }
    cache = createReadCache(store)
  }
  return cache<T>(key, load, options)
}
