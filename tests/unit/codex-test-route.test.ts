import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireUser } from '../../server/utils/session'
import { testProvider } from '../../server/services/providers'

vi.mock('../../server/utils/api', () => ({ handleApi: (_event: unknown, fn: () => unknown) => fn() }))
vi.mock('../../server/utils/session', () => ({ requireUser: vi.fn() }))
vi.mock('../../server/services/providers', () => ({ testProvider: vi.fn() }))

let handler: typeof import('../../server/api/v1/providers/codex/test.post')['default']
beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  handler = (await import('../../server/api/v1/providers/codex/test.post')).default
})
afterEach(() => vi.unstubAllGlobals())

describe('explicit Codex test endpoint', () => {
  it('returns the Codex health check without requiring a dynamic route parameter', async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: 'user' } as never)
    vi.mocked(testProvider).mockResolvedValue({ healthStatus: 'healthy' } as never)
    await expect(handler({} as never)).resolves.toEqual({ healthStatus: 'healthy' })
    expect(testProvider).toHaveBeenCalledWith('codex')
  })

  it('requires authentication before checking the provider', async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error('Unauthorized'))
    await expect(handler({} as never)).rejects.toThrow('Unauthorized')
    expect(testProvider).not.toHaveBeenCalled()
  })
})
