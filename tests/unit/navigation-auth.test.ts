import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('navigation authentication', () => {
  const checkedAt = { value: 0 }
  const api = vi.fn()
  const navigate = vi.fn((path: string) => path)
  let middleware: (to: { path: string }) => Promise<unknown>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    checkedAt.value = 0
    vi.stubGlobal('defineNuxtRouteMiddleware', (handler: typeof middleware) => handler)
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useState', () => checkedAt)
    vi.stubGlobal('navigateTo', navigate)
    const middlewarePath = '../../app/middleware/auth.global.ts'
    middleware = (await import(middlewarePath)).default
    api.mockImplementation(async (url: string) => url.endsWith('setup-status') ? { needsSetup: false } : { user: { id: 'u1' } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('checks the session once and skips network calls on subsequent sidebar navigation', async () => {
    await middleware({ path: '/' })
    expect(api).toHaveBeenCalledTimes(2)
    await middleware({ path: '/repositories' })
    await middleware({ path: '/providers' })
    expect(api).toHaveBeenCalledTimes(2)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rechecks expired state and redirects rejected sessions', async () => {
    checkedAt.value = Date.now() - 61_000
    api.mockImplementation(async (url: string) => {
      if (url.endsWith('setup-status')) return { needsSetup: false }
      throw new Error('expired')
    })
    await middleware({ path: '/tasks' })
    expect(api).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenCalledWith('/login')
  })

  it('invalidates navigation state on login and preserves first-run setup redirects', async () => {
    checkedAt.value = Date.now()
    await middleware({ path: '/login' })
    expect(checkedAt.value).toBe(0)
    api.mockResolvedValue({ needsSetup: true })
    await middleware({ path: '/' })
    expect(navigate).toHaveBeenCalledWith('/setup')
  })
})
