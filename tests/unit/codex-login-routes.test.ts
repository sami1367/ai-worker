import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireAdmin } from '../../server/utils/session'
import { updateProvider, listProviders } from '../../server/services/providers'
import { startCodexLogin, codexLoginState, codexChatgptConnected, disconnectCodexLogin, acknowledgeCodexLogin } from '../../server/services/codex-auth'

vi.mock('../../server/utils/api', () => ({ handleApi: (_event: unknown, fn: () => unknown) => fn(), clientIpHash: () => 'ip-hash' }))
vi.mock('../../server/utils/session', () => ({ requireAdmin: vi.fn() }))
vi.mock('../../server/services/providers', () => ({ updateProvider: vi.fn(), listProviders: vi.fn() }))
vi.mock('../../server/services/codex-auth', () => ({
  startCodexLogin: vi.fn(), codexLoginState: vi.fn(), codexChatgptConnected: vi.fn(),
  disconnectCodexLogin: vi.fn(), acknowledgeCodexLogin: vi.fn(),
}))

const admin = { id: 'admin-id', username: 'admin', role: 'admin' }
const event = {} as never
let start: typeof import('../../server/api/v1/providers/codex/login.post')['default']
let status: typeof import('../../server/api/v1/providers/codex/login.get')['default']
let complete: typeof import('../../server/api/v1/providers/codex/login-complete.post')['default']
let disconnect: typeof import('../../server/api/v1/providers/codex/login.delete')['default']

beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('useRuntimeConfig', () => ({ secretEncryptionKey: 'encryption-key' }))
  vi.mocked(requireAdmin).mockResolvedValue(admin as never)
  vi.mocked(codexLoginState).mockReturnValue({ status: 'idle' })
  start = (await import('../../server/api/v1/providers/codex/login.post')).default
  status = (await import('../../server/api/v1/providers/codex/login.get')).default
  complete = (await import('../../server/api/v1/providers/codex/login-complete.post')).default
  disconnect = (await import('../../server/api/v1/providers/codex/login.delete')).default
})
afterEach(() => vi.unstubAllGlobals())

describe('Codex login API', () => {
  it('requires admin access before any process, status, credential change, or completion', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Administrator role required'))
    for (const route of [start, status, complete, disconnect]) {
      await expect(route(event)).rejects.toThrow('Administrator role required')
    }
    expect(startCodexLogin).not.toHaveBeenCalled()
    expect(codexLoginState).not.toHaveBeenCalled()
    expect(disconnectCodexLogin).not.toHaveBeenCalled()
    expect(updateProvider).not.toHaveBeenCalled()
  })

  it('keeps status read-only and refuses activation without an account cache', async () => {
    vi.mocked(codexLoginState).mockReturnValue({ status: 'pending', userCode: 'ABCD-12345' })
    vi.mocked(codexChatgptConnected).mockReturnValue(false)
    await expect(status(event)).resolves.toEqual({ status: 'pending', userCode: 'ABCD-12345', connected: false })
    expect(updateProvider).not.toHaveBeenCalled()
    await expect(complete(event)).rejects.toThrow('Complete ChatGPT login first')
    expect(updateProvider).not.toHaveBeenCalled()
  })

  it('activates ChatGPT only after successful login, retaining the saved API key', async () => {
    vi.mocked(codexChatgptConnected).mockReturnValue(true)
    await complete(event)
    expect(updateProvider).toHaveBeenCalledWith('codex', { isEnabled: true, config: { credentialType: 'chatgpt' } }, admin, 'encryption-key', 'ip-hash')
    expect(acknowledgeCodexLogin).toHaveBeenCalledWith(admin.id)
  })

  it('cancels login without disabling an active API-key provider', async () => {
    vi.mocked(listProviders).mockResolvedValue([{ providerType: 'codex', config: { credentialType: 'openai_api_key' } }] as never)
    await disconnect(event)
    expect(disconnectCodexLogin).toHaveBeenCalledWith(admin.id)
    expect(updateProvider).toHaveBeenCalledWith('codex', {}, admin, 'encryption-key', 'ip-hash')
    vi.mocked(listProviders).mockResolvedValue([{ providerType: 'codex', config: { credentialType: 'chatgpt' } }] as never)
    await disconnect(event)
    expect(updateProvider).toHaveBeenLastCalledWith('codex', { isEnabled: false }, admin, 'encryption-key', 'ip-hash')
  })
})
