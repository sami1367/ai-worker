import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { codegraphIndexTimeoutMs, codegraphProcessEnv, runCodegraph } from '../../server/services/codegraph-process'
afterEach(() => { vi.unstubAllEnvs() })
describe('CodeGraph process execution', () => {
  it('allows large groups more than the old five-minute indexing limit', () => {
    vi.stubEnv('CODEGRAPH_INDEX_TIMEOUT_SECONDS', '')
    expect(codegraphIndexTimeoutMs()).toBe(1_800_000)
    vi.stubEnv('CODEGRAPH_INDEX_TIMEOUT_SECONDS', '2400')
    expect(codegraphIndexTimeoutMs()).toBe(2_400_000)
    expect(codegraphProcessEnv().PATH).toContain('.local')
  })
  it('streams more than the previous output limit without killing indexing', async () => {
    vi.stubEnv('CODEGRAPH_BIN', process.execPath)
    const result = await runCodegraph(['-e', 'process.stdout.write("x".repeat(700000)+"finished")'], tmpdir(), 5000)
    expect(result.stdout.endsWith('finished')).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(32_000)
  })
  it('reports the real command error and redacts tokens', async () => {
    vi.stubEnv('CODEGRAPH_BIN', process.execPath)
    const token = `ghp_${'a'.repeat(30)}`
    const result = runCodegraph(['-e', `process.stderr.write("Database is locked ${token}");process.exit(7)`], tmpdir(), 5000)
    await expect(result).rejects.toThrow('Database is locked [REDACTED]')
  })
  it('reports a missing CLI with web-runtime setup guidance', async () => {
    vi.stubEnv('CODEGRAPH_BIN', '/nonexistent-aiw-codegraph-executable')
    await expect(runCodegraph(['status'], tmpdir(), 1000)).rejects.toThrow('not found by the web service')
  })
  it('reports timeouts instead of silently marking the graph unavailable', async () => {
    vi.stubEnv('CODEGRAPH_BIN', process.execPath)
    await expect(runCodegraph(['-e', 'setInterval(()=>{},1000)'], tmpdir(), 50)).rejects.toThrow('timed out')
  })
})
