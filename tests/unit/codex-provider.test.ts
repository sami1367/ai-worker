import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { providerConfigs } from '../../database/schema'
import { getDb } from '../../server/utils/db'
import { codexHome } from '../../server/services/codex-auth'
import { publicProvider } from '../../server/services/providers'
import { exportProviderCredentialsForWorker } from '../../server/services/provider-credentials'
import { resolvePlanningProvider } from '../../server/services/task-planning-llm'

vi.mock('../../server/utils/db', () => ({ getDb: vi.fn() }))
vi.mock('../../server/services/audit', () => ({ writeAudit: vi.fn() }))
vi.mock('../../server/services/settings', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }))

let base: string
const row = (credentialType: string): typeof providerConfigs.$inferSelect => ({
  id: 'codex-id', displayName: 'Codex CLI', isDefault: false,
  healthStatus: 'unknown', healthMessage: null, detectedVersion: null, lastHealthCheckAt: null,
  createdAt: new Date(), updatedAt: new Date(),
  providerType: 'codex', config: { credentialType }, isEnabled: true,
  secretCiphertext: 'retained-api-ciphertext',
})

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aiw-codex-provider-'))
  vi.stubEnv('AI_WORKER_BASE_DIR', base)
  vi.stubEnv('OPENAI_API_KEY', 'test-api-key')
  vi.stubEnv('CODEX_API_KEY', '')
  vi.stubEnv('SECRET_ENCRYPTION_KEY', '')
  await mkdir(codexHome())
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(base, { recursive: true, force: true })
})
async function connect() {
  await writeFile(join(codexHome(), 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'private-access', refresh_token: 'private-refresh' } }))
}
function rows(items: unknown[]) {
  vi.mocked(getDb).mockReturnValue({ select: () => ({ from: async () => items }) } as never)
}

describe('Codex provider authentication modes', () => {
  it('requires an account cache in ChatGPT mode even when stored or environment API keys exist', async () => {
    expect(publicProvider(row('chatgpt')).hasSecret).toBe(false)
    await connect()
    const account = publicProvider(row('chatgpt'))
    expect(account.hasSecret).toBe(true)
    expect(account.hasStoredSecret).toBe(false)
    expect(account.hasApiKey).toBe(true)
    expect(account.secretSource).toBe('chatgpt')
    expect(JSON.stringify(account)).not.toMatch(/private-access|private-refresh|retained-api-ciphertext|test-api-key/)
    expect(publicProvider(row('openai_api_key')).secretSource).toBe('stored')
  })

  it('exports the selected mode and persistent home without copying OAuth tokens into the env file', async () => {
    await connect()
    rows([row('chatgpt')])
    const exported = await exportProviderCredentialsForWorker()
    expect(exported.codex).toBe(true)
    let env = await readFile(exported.path, 'utf8')
    expect(env).toContain("export AI_CODEX_AUTH_MODE='chatgpt'")
    expect(env).toContain(`export AI_CODEX_ACCOUNT_HOME='${codexHome()}'`)
    expect(env).not.toMatch(/private-access|private-refresh/)
    rows([row('openai_api_key')])
    await exportProviderCredentialsForWorker()
    env = await readFile(exported.path, 'utf8')
    expect(env).toContain("export AI_CODEX_AUTH_MODE='api'")
  })

  it('does not silently charge retained API keys for planning when ChatGPT mode is selected', async () => {
    rows([row('chatgpt')])
    await expect(resolvePlanningProvider('codex')).rejects.toThrow('API key')
    await connect()
    await expect(resolvePlanningProvider('codex')).resolves.toMatchObject({ transport: 'codex-cli', model: '', providerType: 'codex' })
    expect((await resolvePlanningProvider('codex')).apiKey).toBe('')
    rows([row('openai_api_key')])
    await expect(resolvePlanningProvider('codex')).resolves.toMatchObject({ apiKey: 'test-api-key', providerType: 'codex' })
  })
})
