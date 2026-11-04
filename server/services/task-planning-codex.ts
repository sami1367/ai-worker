import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '#utils/errors'
import { codexLoginEnv } from './codex-auth'
import type { PlanningLlmMessage } from './task-planning-llm'

/** Run account-authenticated planning without API-key overrides or application secrets. */
export async function callCodexPlanning(messages: PlanningLlmMessage[], model: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'aiw-planning-'))
  try {
    const output = join(workspace, 'response.txt')
    const args = [
      'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
      '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"',
      '-c', 'features.shell_tool=false',
      '--output-last-message', output,
    ]
    if (model) args.push('--model', model)
    args.push('-')
    const prompt = 'Continue the following planning conversation. Return only the assistant response. Do not use tools or inspect files.\n\n'
      + JSON.stringify(messages)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd: workspace, env: codexLoginEnv(), stdio: ['pipe', 'ignore', 'ignore'],
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new AppError(504, 'Codex planning timed out. Try again.', 'planning_llm_error'))
      }, 90_000)
      child.stdin.on('error', () => { /* close/error reports a failed process */ })
      child.once('error', () => {
        clearTimeout(timer)
        reject(new AppError(502, 'Could not start Codex CLI for planning.', 'planning_llm_error'))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new AppError(502, 'Codex planning failed. Check your ChatGPT connection and Codex allowance in Providers.', 'planning_llm_error'))
      })
      child.stdin.end(prompt)
    })
    const text = (await readFile(output, 'utf8').catch(() => '')).trim()
    if (!text) throw new AppError(502, 'Codex returned an empty response', 'planning_llm_empty')
    return text
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
