import { describe, expect, it, vi } from 'vitest'
import { createReadCache, readCacheKey } from '../../server/utils/read-cache'

describe('read cache', () => {
  it('coalesces concurrent misses, caches results, and expires them', async () => {
    let now = 0
    const cache = createReadCache(undefined, () => now)
    const load = vi.fn(async () => ['main'])
    const options = { ttlSeconds: 30 }
    expect(await Promise.all([cache('repo', load, options), cache('repo', load, options)])).toEqual([['main'], ['main']])
    await cache('repo', load, options)
    expect(load).toHaveBeenCalledTimes(1)
    now = 30_001
    await cache('repo', load, options)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('serves stale data during one background refresh and retries failed loads', async () => {
    let now = 0
    const cache = createReadCache(undefined, () => now)
    const options = { ttlSeconds: 1, staleSeconds: 10 }
    await cache('plan', async () => 'old', options)
    now = 2000
    let finish!: (value: string) => void
    const load = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    expect(await cache('plan', load, options)).toBe('old')
    expect(await cache('plan', load, options)).toBe('old')
    expect(load).toHaveBeenCalledTimes(1)
    finish('new')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await cache('plan', load, options)).toBe('new')
    const fail = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('recovered')
    await expect(cache('other', fail, options)).rejects.toThrow('offline')
    expect(await cache('other', fail, options)).toBe('recovered')
  })

  it('uses shared storage and falls back to memory when Redis is unavailable', async () => {
    const values = new Map<string, string>()
    const store = { get: vi.fn(async (key: string) => values.get(key) || null), set: vi.fn(async (key: string, value: string) => { values.set(key, value) }) }
    const load = vi.fn(async () => 42)
    await createReadCache(store)('shared', load, { ttlSeconds: 10 })
    expect(await createReadCache(store)('shared', load, { ttlSeconds: 10 })).toBe(42)
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.set).toHaveBeenCalledWith('shared', expect.any(String), 10)
    store.get.mockRejectedValue(new Error('offline'))
    store.set.mockRejectedValue(new Error('offline'))
    const fallback = createReadCache(store)
    await fallback('fallback', load, { ttlSeconds: 10 })
    await fallback('fallback', load, { ttlSeconds: 10 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('returns a cold placeholder without waiting for slow providers', async () => {
    const cache = createReadCache()
    let finish!: (value: string[]) => void
    const load = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve }))
    expect(await cache('cold', load, { ttlSeconds: 120, coldValue: () => [] })).toEqual([])
    const snapshotRequest = cache('cold', load, { ttlSeconds: 120 })
    finish(['account'])
    expect(await snapshotRequest).toEqual(['account'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('isolates credential and host identities without including secrets in keys', () => {
    const key = readCacheKey('branches', ['https://gitlab.example', 'secret-one'])
    expect(key).not.toContain('secret-one')
    expect(key).not.toBe(readCacheKey('branches', ['https://gitlab.example', 'secret-two']))
    expect(key).not.toBe(readCacheKey('branches', ['https://other.example', 'secret-one']))
  })
})
