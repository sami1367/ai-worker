import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { homedir } from 'node:os'
import { redactSecrets } from '#utils/redact'

export function codegraphProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', CI: '1', PATH: [
    process.env.PATH || '', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin',
  ].filter(Boolean).join(delimiter) }
}
export function codegraphIndexTimeoutMs() {
  const seconds = Number(process.env.CODEGRAPH_INDEX_TIMEOUT_SECONDS || 7200)
  return (Number.isFinite(seconds) ? Math.min(7200, Math.max(60, seconds)) : 7200) * 1000
}

/** Stream output with a bounded diagnostic tail; verbose indexers must not hit execFile's maxBuffer. */
export async function runCodegraph(args: string[], cwd: string, timeoutMs = codegraphIndexTimeoutMs()) {
  return new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
    const executable = process.env.CODEGRAPH_BIN || 'codegraph'
    const child = spawn(executable, args, { cwd, env: codegraphProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, 5000)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-32_000) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32_000) })
    const clearTimers = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer) }
    child.once('error', error => {
      clearTimers()
      const detail = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'CodeGraph executable was not found by the web service. Install it in the web runtime or set CODEGRAPH_BIN to its absolute path.'
        : error.message
      reject(new Error(redactSecrets(detail)))
    })
    child.once('close', (code, signal) => {
      clearTimers()
      if (code === 0 && !timedOut) { resolve({ stdout, stderr }); return }
      const reason = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} seconds; increase CODEGRAPH_INDEX_TIMEOUT_SECONDS for large groups`
        : signal ? `terminated by ${signal}${signal === 'SIGKILL' ? ' (check the web container memory limit / OOM logs)' : ''}` : `exited with code ${code}`
      const detail = redactSecrets(stripVTControlCharacters(stderr || stdout).trim().slice(-1800))
      reject(new Error(`CodeGraph ${args[0]} ${reason}${detail ? `: ${detail}` : ''}`))
    })
  })
}
