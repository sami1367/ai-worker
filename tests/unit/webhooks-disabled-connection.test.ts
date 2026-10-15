import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('../../server/utils/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../server/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/crypto')>()
  return {
    ...actual,
    encryptSecret: (v: string) => `enc:${v}`,
    decryptSecret: (v: string) => {
      if (!v.startsWith('enc:')) throw new Error('bad cipher')
      return v.slice(4)
    },
  }
})

vi.mock('../../server/services/task-queue', () => ({
  syncQueueForRepositoryFullName: vi.fn(async () => undefined),
}))

import { getDb } from '../../server/utils/db'
import {
  handleGitHubWebhook,
  handleGitLabWebhook,
} from '../../server/services/webhooks'

describe('webhooks ignore disabled connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SECRET_ENCRYPTION_KEY = 'test-encryption-key-32chars!!!!!!'
  })

  it('verifies GitHub signature but does not wake when connection is disabled', async () => {
    const row = {
      id: 'conn-1',
      provider: 'github',
      status: 'disconnected',
      webhookSecretCiphertext: 'enc:webhook-secret',
    }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }),
    } as never)

    const body = JSON.stringify({
      action: 'labeled',
      label: { name: 'ai' },
      issue: { number: 1 },
      repository: { id: 1, full_name: 'acme/widget' },
    })
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`

    const result = await handleGitHubWebhook({
      connectionId: 'conn-1',
      eventName: 'issues',
      signature,
      rawBody: body,
      payload: JSON.parse(body),
    })

    expect(result.wokeWorker).toBe(false)
    expect(result.kind).toBe('issue')
  })

  it('verifies GitLab token but does not wake when connection is disabled', async () => {
    const row = {
      id: 'conn-2',
      provider: 'gitlab',
      status: 'disconnected',
      webhookSecretCiphertext: 'enc:gitlab-secret',
    }
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }),
    } as never)

    const result = await handleGitLabWebhook({
      connectionId: 'conn-2',
      tokenHeader: 'gitlab-secret',
      payload: {
        object_kind: 'issue',
        object_attributes: { action: 'open', iid: 2 },
        project: { id: 1, path_with_namespace: 'g/p' },
        labels: [{ title: 'ai' }],
      },
    })

    expect(result.wokeWorker).toBe(false)
    expect(result.kind).toBe('issue')
  })
})
