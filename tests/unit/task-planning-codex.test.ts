import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callCodexPlanning } from '../../server/services/task-planning-codex'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function mockCli(code = 0, response = 'Planned tasks') {
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[], options: { env: NodeJS.ProcessEnv, cwd: string }) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: vi.fn() })
    let prompt = ''
    child.stdin.on('data', chunk => { prompt += chunk.toString() })
    child.stdin.on('finish', async () => {
      expect(JSON.parse(prompt.slice(prompt.indexOf('[{')))).toEqual([{ role: 'user', content: 'Plan this epic' }])
      expect(options.env.OPENAI_API_KEY).toBeUndefined()
      expect(options.env.CODEX_API_KEY).toBeUndefined()
      expect(options.env.GITHUB_TOKEN).toBeUndefined()
      if (code === 0) await writeFile(args[args.indexOf('--output-last-message') + 1]!, response)
      child.emit('close', code)
    })
    return child
  }) as never)
}

describe('Codex account planning', () => {
  it('uses the CLI account, sends history over stdin, and returns the final response', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-use')
    vi.stubEnv('GITHUB_TOKEN', 'must-not-leak')
    mockCli()
    await expect(callCodexPlanning([{ role: 'user', content: 'Plan this epic' }], '')).resolves.toBe('Planned tasks')
    const args = vi.mocked(spawn).mock.calls[0]![1]!
    expect(args).toContain('forced_login_method="chatgpt"')
    expect(args).toContain('read-only')
    expect(args).not.toContain('--model')
  })
  it('reports CLI failures without returning process output', async () => {
    mockCli(1)
    await expect(callCodexPlanning([{ role: 'user', content: 'Plan this epic' }], 'custom-model')).rejects.toThrow('Codex planning failed')
    expect(vi.mocked(spawn).mock.calls[0]![1]).toContain('custom-model')
  })
  it('rejects an empty final response', async () => {
    mockCli(0, '')
    await expect(callCodexPlanning([{ role: 'user', content: 'Plan this epic' }], '')).rejects.toThrow('empty response')
  })
})
