// Process-group and timeout handling for the coding phase on Linux and macOS.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const spec = process.argv[2]
if (!spec) throw new Error('Prepared work specification is required')
const child = spawn('bash', [fileURLToPath(new URL('./run-chat-work.sh', import.meta.url)), spec], {
  detached: true, stdio: 'inherit',
})
let forcedExit = 0
let killTimer
function stop(code) {
  forcedExit = code
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* child already exited */ }
  killTimer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* child already exited */ }
  }, 15_000)
  killTimer.unref()
}
const timeout = setTimeout(() => stop(124), Number(process.env.CHAT_WORK_TIMEOUT_SECONDS || 7200) * 1000)
timeout.unref()
process.on('SIGTERM', () => stop(143))
process.on('SIGINT', () => stop(130))
child.on('error', () => { clearTimeout(timeout); process.exitCode = 127 })
child.on('exit', (code, signal) => {
  clearTimeout(timeout)
  clearTimeout(killTimer)
  // Clean up any descendants that outlived the coding agent.
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* no remaining descendants */ }
  process.exitCode = forcedExit || (signal ? 128 + ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }[signal] || 1) : (code ?? 1))
})
