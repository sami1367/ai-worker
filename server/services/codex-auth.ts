import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { workerBaseDir } from '#utils/paths'
import { AppError } from '#utils/errors'

// Shared by web and worker; separate from the operator's personal ~/.codex.
export function codexHome(): string {
  return join(workerBaseDir(), 'codex-account')
}

export function codexChatgptConnected(): boolean {
  try {
    const auth = JSON.parse(readFileSync(join(codexHome(), 'auth.json'), 'utf8'))
    return auth.auth_mode === 'chatgpt' && Boolean(auth.tokens?.access_token && auth.tokens?.refresh_token)
  } catch {
    return false
  }
}

export function codexLoginEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome(), NO_COLOR: '1', TERM: 'dumb' }
  // Login never receives forge tokens, app secrets, or API-key overrides.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

type LoginState = {
  status: 'idle' | 'starting' | 'pending' | 'success' | 'error'
  verificationUrl?: string
  userCode?: string
  message?: string
}
let login: { owner: string, state: LoginState, child?: ChildProcess } | undefined
let starting = false

export function parseCodexDevicePrompt(output: string): { verificationUrl?: string, userCode?: string } {
  const plain = stripVTControlCharacters(output)
  // Only render OpenAI's device URL, never arbitrary CLI output or token material.
  const verificationUrl = plain.match(/https:\/\/auth\.openai\.com\/codex\/device(?=[\s)\]"']|$)/)?.[0]
  const userCode = plain.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0]
  return { verificationUrl, userCode }
}

export function codexLoginState(owner: string): LoginState {
  if (login && login.owner !== owner && ['starting', 'pending'].includes(login.state.status)) throw new AppError(409, 'Another administrator is signing in to Codex', 'conflict')
  return login?.owner === owner ? { ...login.state } : { status: 'idle' }
}

export async function startCodexLogin(owner: string): Promise<LoginState> {
  if (starting) throw new AppError(409, 'Codex login is starting', 'conflict')
  const current = codexLoginState(owner)
  if (current.status === 'starting' || current.status === 'pending') return current
  if (codexChatgptConnected()) throw new AppError(409, 'ChatGPT is already signed in. Use the existing session or disconnect first.', 'conflict')
  starting = true
  try {
    await mkdir(codexHome(), { recursive: true, mode: 0o700 })
    await chmod(codexHome(), 0o700)
    const session: NonNullable<typeof login> = { owner, state: { status: 'starting' } }
    login = session
    const child = spawn('codex', ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'], {
      env: codexLoginEnv(), cwd: codexHome(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    session.child = child
    let output = ''
    const consume = (chunk: Buffer) => {
      if (session.state.status === 'error' || session.state.status === 'success') return
      output = (output + chunk.toString()).slice(-16384)
      const prompt = parseCodexDevicePrompt(output)
      if (prompt.verificationUrl && prompt.userCode) session.state = { status: 'pending', ...prompt }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    const timer = setTimeout(() => {
      session.state = { status: 'error', message: 'Login expired. Start again to get a new code.' }
      child.kill('SIGKILL')
    }, 15 * 60 * 1000)
    timer.unref()
    child.on('error', () => {
      clearTimeout(timer)
      session.state = { status: 'error', message: 'Could not start Codex CLI. Check that it is installed on the server.' }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      session.child = undefined
      if (session.state.status === 'error') return
      session.state = code === 0 && codexChatgptConnected()
        ? { status: 'success' }
        : { status: 'error', message: 'ChatGPT login failed or expired. Enable device code login in ChatGPT security settings, then try again.' }
      output = ''
    })
    return { ...session.state }
  } finally {
    starting = false
  }
}

export async function disconnectCodexLogin(owner: string): Promise<void> {
  if (starting) throw new AppError(409, 'Codex login is changing. Try again.', 'conflict')
  codexLoginState(owner)
  starting = true
  try {
    const child = login?.child
    if (child) {
      // Wait for termination before removing the cache, so a late completion cannot restore it.
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        child.kill('SIGKILL')
      })
    }
    login = undefined
    await unlink(join(codexHome(), 'auth.json')).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
  } finally {
    starting = false
  }
}

export function acknowledgeCodexLogin(owner: string): void {
  codexLoginState(owner)
  if (login?.owner === owner && login.state.status === 'success') login = undefined
}
