import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/services/connections', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/connections')>(
    '../../server/services/connections',
  )
  return {
    ...actual,
    listPausedConnectionIds: vi.fn(async () => ['paused-conn']),
  }
})

vi.mock('../../server/services/settings', () => ({
  getSettings: vi.fn(async () => ({ configVersion: 1, pollIntervalSeconds: 60 })),
  bumpConfigVersion: vi.fn(async () => ({ configVersion: 2 })),
}))

vi.mock('../../server/services/audit', () => ({
  writeAudit: vi.fn(async () => undefined),
}))

vi.mock('../../server/utils/paths', () => ({
  workerBaseDir: () => '/tmp/ai-worker-test-worker',
}))

const { written } = vi.hoisted(() => ({
  written: new Map<string, string>(),
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (path: string, body: string) => {
    written.set(String(path), String(body))
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const body = written.get(String(from))
    if (body != null) written.set(String(to), body)
  }),
  readFile: vi.fn(async (path: string) => {
    const body = written.get(String(path))
    if (body == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return body
  }),
}))

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    cb(new Error('jq missing'))
  },
}))

import { mkdir } from 'node:fs/promises'
import { getDb } from '../../server/utils/db'
import { listPausedConnectionIds } from '../../server/services/connections'
import { exportWorkerConfig } from '../../server/services/config-sync'

describe('exportWorkerConfig skips paused connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    written.clear()
  })

  it('does not export repos linked to a disabled connection', async () => {
    const rows = [
      {
        id: 'r1',
        name: 'active-repo',
        forgeType: 'github',
        isEnabled: true,
        isArchived: false,
        localPath: '/data/workspaces/a',
        connectionId: 'active-conn',
        canonicalProjectIdentifier: 'acme/active',
        remoteUrl: 'https://github.com/acme/active.git',
        defaultBranch: 'main',
        blockOnOpenPr: true,
        forcePushToDefault: false,
        settings: {},
      },
      {
        id: 'r2',
        name: 'paused-repo',
        forgeType: 'github',
        isEnabled: true,
        isArchived: false,
        localPath: '/data/workspaces/b',
        connectionId: 'paused-conn',
        canonicalProjectIdentifier: 'acme/paused',
        remoteUrl: 'https://github.com/acme/paused.git',
        defaultBranch: 'main',
        blockOnOpenPr: true,
        forcePushToDefault: false,
        settings: {},
      },
    ]

    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    } as never)

    const result = await exportWorkerConfig()
    expect(listPausedConnectionIds).toHaveBeenCalled()
    expect(result.githubCount).toBe(1)
    expect(result.gitlabCount).toBe(0)

    const githubPath = [...written.keys()].find((p) => p.endsWith('github-projects.conf'))
    expect(githubPath).toBeTruthy()
    const body = JSON.parse(written.get(githubPath!)!)
    expect(body).toHaveLength(1)
    expect(body[0].name).toBe('active-repo')
    expect(mkdir).toHaveBeenCalled()
  })
})
