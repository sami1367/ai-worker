import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

let base: string
let auth: typeof import('../../server/services/codex-auth')
let child: EventEmitter & { stdout: PassThrough, stderr: PassThrough, kill: ReturnType<typeof vi.fn> }
const cache = { auth_mode: 'chatgpt', tokens: { access_token: 'private-access', refresh_token: 'private-refresh' } }

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  base = await mkdtemp(join(tmpdir(), 'aiw-codex-auth-'))
  vi.stubEnv('AI_WORKER_BASE_DIR', base)
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true }),
  })
  vi.mocked(spawn).mockReturnValue(child as never)
  auth = await import('../../server/services/codex-auth')
})
afterEach(async () => {
  child.emit('close', 1)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(base, { recursive: true, force: true })
})

describe('Codex ChatGPT device login', () => {
  it('renders only a trusted device URL and code, never arbitrary logs', () => {
    expect(auth.parseCodexDevicePrompt('\x1b[32mhttps://auth.openai.com/codex/device\x1b[0m\nABCD-12345\nprivate-access')).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345',
    })
    expect(auth.parseCodexDevicePrompt('https://auth.openai.com.attacker.test/codex/device ABCD-12345').verificationUrl).toBeUndefined()
    expect(auth.parseCodexDevicePrompt('https://attacker.test/ ABCD-12345').verificationUrl).toBeUndefined()
  })

  it('scrubs secrets and uses private persistent storage, captures split output, then acknowledges completion', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-api-key')
    vi.stubEnv('CODEX_API_KEY', 'private-codex-key')
    vi.stubEnv('GH_TOKEN', 'private-forge')
    vi.stubEnv('DATABASE_URL', 'private-database')
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'private-access-token')
    expect(await auth.startCodexLogin('admin')).toEqual({ status: 'starting' })
    const options = vi.mocked(spawn).mock.calls[0]![2]!
    expect(options.env).toMatchObject({ CODEX_HOME: join(base, 'codex-account') })
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GH_TOKEN', 'DATABASE_URL', 'CODEX_ACCESS_TOKEN']) {
      expect(options.env).not.toHaveProperty(key)
    }
    expect((await stat(auth.codexHome())).mode & 0o777).toBe(0o700)
    child.stdout.write('Open https://auth.openai.com/codex/de')
    child.stdout.write('vice\nEnter ABCD-12345\nprivate-access')
    expect(auth.codexLoginState('admin')).toEqual({ status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' })
    expect(() => auth.codexLoginState('another-admin')).toThrow('Another administrator')
    await auth.startCodexLogin('admin')
    expect(spawn).toHaveBeenCalledTimes(1)
    await writeFile(join(auth.codexHome(), 'auth.json'), JSON.stringify(cache), { mode: 0o600 })
    child.emit('close', 0)
    expect(auth.codexLoginState('admin')).toEqual({ status: 'success' })
    expect(auth.codexChatgptConnected()).toBe(true)
    auth.acknowledgeCodexLogin('admin')
    expect(auth.codexLoginState('admin')).toEqual({ status: 'idle' })
    expect(await readFile(join(auth.codexHome(), 'auth.json'), 'utf8')).toContain('private-refresh')
  })

  it('does not confuse an API key cache, corrupt cache, or failed CLI with ChatGPT login', async () => {
    await mkdir(auth.codexHome())
    await writeFile(join(auth.codexHome(), 'auth.json'), '{bad json')
    expect(auth.codexChatgptConnected()).toBe(false)
    await writeFile(join(auth.codexHome(), 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }))
    expect(auth.codexChatgptConnected()).toBe(false)
    await auth.startCodexLogin('admin')
    child.stderr.write('private-sensitive-error')
    child.emit('error', new Error('private-spawn-error'))
    expect(auth.codexLoginState('admin').status).toBe('error')
    expect(JSON.stringify(auth.codexLoginState('admin'))).not.toContain('private-')
  })

  it('expires a pending login and permits another administrator to retry', async () => {
    vi.useFakeTimers()
    await auth.startCodexLogin('admin')
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(auth.codexLoginState('admin').status).toBe('error')
    await auth.startCodexLogin('other-admin')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('cancels before deleting credentials so a late write cannot restore the session', async () => {
    await auth.startCodexLogin('admin')
    await writeFile(join(auth.codexHome(), 'auth.json'), JSON.stringify(cache))
    await auth.disconnectCodexLogin('admin')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(auth.codexChatgptConnected()).toBe(false)
    expect(auth.codexLoginState('admin')).toEqual({ status: 'idle' })
  })
})
