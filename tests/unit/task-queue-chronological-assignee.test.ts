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
    ensureConnectionAccount: vi.fn(),
    listPausedConnectionIds: vi.fn(async () => []),
  }
})

vi.mock('../../server/services/queue-events', () => ({
  publishQueueUpdated: vi.fn(),
}))

vi.mock('../../server/services/forge-github', () => ({
  listGitHubAiIssues: vi.fn(async () => []),
  listGitHubAiPullRequests: vi.fn(async () => []),
}))

vi.mock('../../server/services/forge-gitlab', () => ({
  listGitLabAiIssues: vi.fn(async () => []),
  listGitLabAiMergeRequests: vi.fn(async () => []),
}))

import { getDb } from '../../server/utils/db'
import { ensureConnectionAccount } from '../../server/services/connections'
import { listGitHubAiIssues, listGitHubAiPullRequests } from '../../server/services/forge-github'
import { listGitLabAiIssues, listGitLabAiMergeRequests } from '../../server/services/forge-gitlab'
import {
  computeNextTask,
  syncRepositoryQueue,
  type QueueItem,
} from '../../server/services/task-queue'

function baseItem(
  overrides: Partial<QueueItem> & Pick<QueueItem, 'id' | 'externalId' | 'kind' | 'labels' | 'phase'>,
): QueueItem {
  return {
    repositoryId: 'repo-1',
    repositoryName: 'owner/repo',
    forgeType: 'github',
    taskType: overrides.kind === 'issue'
      ? 'github_issue'
      : overrides.kind === 'merge_request'
        ? 'gitlab_mr_review'
        : 'github_pr_review',
    phaseLabel: 'Queued',
    statusReason: null,
    title: 't',
    url: 'https://example.test',
    assignees: [{ id: '1', login: 'me' }],
    sourceBranch: null,
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    assignedWorker: null,
    isNext: false,
    ...overrides,
  }
}

describe('chronological order + assignee eligibility', () => {
  const inserted: unknown[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    inserted.length = 0
    vi.mocked(listGitHubAiIssues).mockResolvedValue([])
    vi.mocked(listGitHubAiPullRequests).mockResolvedValue([])
    vi.mocked(listGitLabAiIssues).mockResolvedValue([])
    vi.mocked(listGitLabAiMergeRequests).mockResolvedValue([])
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: unknown) => {
          inserted.push(vals)
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as never)
  })

  // 1 + 2: oldest ai labeled but other assignee skipped; next assigned processed first
  it('skips oldest ai issue assigned to another user and keeps the assigned older eligible one', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubAiIssues).mockResolvedValue([
      {
        externalId: '1',
        title: 'other-assignee',
        url: 'https://github.com/a/b/issues/1',
        labels: ['ai'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '9', login: 'other' }],
      },
      {
        externalId: '2',
        title: 'mine',
        url: 'https://github.com/a/b/issues/2',
        labels: ['ai'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'issue',
        assignees: [{ id: '1', login: 'me' }],
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)

    expect(result).toEqual({ ok: true, itemCount: 1 })
    const issue = inserted.find((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'issue',
    ) as { externalId: string }
    expect(issue.externalId).toBe('2')
  })

  // 3 + 4: ai-review PR assignee gate
  it('does not persist unassigned ai-review PR; persists assigned ai-review PR', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubAiPullRequests).mockResolvedValue([
      {
        externalId: '10',
        title: 'unassigned review',
        url: 'https://github.com/a/b/pull/10',
        labels: ['ai-review'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'pull_request',
        sourceBranch: 'feat',
        assignees: [],
      },
      {
        externalId: '11',
        title: 'other review',
        url: 'https://github.com/a/b/pull/11',
        labels: ['ai-review'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'pull_request',
        sourceBranch: 'feat2',
        assignees: [{ id: '9', login: 'other' }],
      },
      {
        externalId: '12',
        title: 'mine review',
        url: 'https://github.com/a/b/pull/12',
        labels: ['ai-review'],
        createdAt: '2026-01-03T00:00:00Z',
        kind: 'pull_request',
        sourceBranch: 'feat3',
        assignees: [{ id: '1', login: 'me' }],
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)

    expect(result.ok).toBe(true)
    const prs = inserted.filter((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'pull_request',
    ) as Array<{ externalId: string, assignees: unknown[] }>
    expect(prs.map((p) => p.externalId)).toEqual(['12'])
    expect(prs[0].assignees).toEqual([{ id: '1', login: 'me' }])

    const next = computeNextTask(
      [
        baseItem({
          id: 'pr-unassigned',
          externalId: '10',
          kind: 'pull_request',
          labels: ['ai-review'],
          phase: 'review_queued',
          taskType: 'github_pr_review',
          assignees: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        baseItem({
          id: 'pr-mine',
          externalId: '12',
          kind: 'pull_request',
          labels: ['ai-review'],
          phase: 'review_queued',
          taskType: 'github_pr_review',
          assignees: [{ id: '1', login: 'me' }],
          createdAt: '2026-01-03T00:00:00.000Z',
        }),
      ],
      new Map([['repo-1', true]]),
    )
    expect(next?.id).toBe('pr-mine')
  })

  // 5 + 6: ai-review MR assignee gate
  it('does not persist unassigned ai-review MR; persists assigned ai-review MR', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c2', accountId: '42', accountLogin: 'me', instanceUrl: 'https://gitlab.example' },
    } as never)
    vi.mocked(listGitLabAiMergeRequests).mockResolvedValue([
      {
        externalId: '20',
        title: 'unassigned',
        url: 'https://gitlab.example/g/p/-/merge_requests/20',
        labels: ['ai-review'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'merge_request',
        sourceBranch: 'feat',
        assignees: [],
      },
      {
        externalId: '21',
        title: 'mine',
        url: 'https://gitlab.example/g/p/-/merge_requests/21',
        labels: ['ai-review'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'merge_request',
        sourceBranch: 'feat2',
        assignees: [{ id: '42', login: 'me' }],
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r2',
      name: 'g/p',
      forgeType: 'gitlab',
      connectionId: 'c2',
      canonicalProjectIdentifier: 'g/p',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: 'https://gitlab.example',
    } as never)

    expect(result.ok).toBe(true)
    const mrs = inserted.filter((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'merge_request',
    ) as Array<{ externalId: string }>
    expect(mrs.map((m) => m.externalId)).toEqual(['21'])

    const next = computeNextTask(
      [
        baseItem({
          id: 'mr-none',
          repositoryId: 'r2',
          forgeType: 'gitlab',
          externalId: '20',
          kind: 'merge_request',
          labels: ['ai-review'],
          phase: 'review_queued',
          taskType: 'gitlab_mr_review',
          assignees: [],
        }),
        baseItem({
          id: 'mr-mine',
          repositoryId: 'r2',
          forgeType: 'gitlab',
          externalId: '21',
          kind: 'merge_request',
          labels: ['ai-review'],
          phase: 'review_queued',
          taskType: 'gitlab_mr_review',
          assignees: [{ id: '42', login: 'me' }],
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
      ],
      new Map([['r2', true]]),
    )
    expect(next?.id).toBe('mr-mine')
  })

  // 7: global chronological order across GitHub and GitLab
  it('picks the globally oldest eligible task across GitHub and GitLab', () => {
    const ghIssue = baseItem({
      id: 'github:issue:r1:5',
      repositoryId: 'r1',
      repositoryName: 'gh/app',
      forgeType: 'github',
      externalId: '5',
      kind: 'issue',
      labels: ['ai'],
      phase: 'queued',
      taskType: 'github_issue',
      createdAt: '2026-01-05T00:00:00.000Z',
    })
    const glReview = baseItem({
      id: 'gitlab:mr:r2:3',
      repositoryId: 'r2',
      repositoryName: 'gl/app',
      forgeType: 'gitlab',
      externalId: '3',
      kind: 'merge_request',
      labels: ['ai-review'],
      phase: 'review_queued',
      taskType: 'gitlab_mr_review',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    const next = computeNextTask(
      [ghIssue, glReview],
      new Map([['r1', true], ['r2', true]]),
    )
    expect(next?.id).toBe('gitlab:mr:r2:3')
  })

  // 9: label but no assignee → skip (issues and review PRs)
  it('skips labeled tasks with no assignee', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubAiIssues).mockResolvedValue([
      {
        externalId: '1',
        title: 'unassigned',
        url: 'https://github.com/a/b/issues/1',
        labels: ['ai'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'issue',
        assignees: [],
      },
    ])
    // Clear default mock leftover from prior tests that may return PRs
    vi.mocked(listGitHubAiPullRequests).mockResolvedValue([
      {
        externalId: '7',
        title: 'unassigned review',
        url: 'https://github.com/a/b/pull/7',
        labels: ['ai-review'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'pull_request',
        sourceBranch: 'x',
        assignees: [],
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)
    expect(result).toEqual({ ok: true, itemCount: 0 })
  })

  // 10: assigned but no relevant label → list helpers already exclude; sync gets empty
  it('does not invent work when forge lists return no AI-labeled items', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubAiIssues).mockResolvedValue([])
    vi.mocked(listGitHubAiPullRequests).mockResolvedValue([])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)
    expect(result).toEqual({ ok: true, itemCount: 0 })
  })

  // 11: identical timestamps → deterministic tie-break by id
  it('uses deterministic id tie-break when createdAt is identical', () => {
    const a = baseItem({
      id: 'github:issue:r1:2',
      externalId: '2',
      kind: 'issue',
      labels: ['ai'],
      phase: 'queued',
      taskType: 'github_issue',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const b = baseItem({
      id: 'github:issue:r1:1',
      externalId: '1',
      kind: 'issue',
      labels: ['ai'],
      phase: 'queued',
      taskType: 'github_issue',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const next = computeNextTask([a, b], new Map([['repo-1', true]]))
    expect(next?.id).toBe('github:issue:r1:1')
  })

  // 12: repeated discovery does not duplicate (onConflict + keepKeys)
  it('upserts the same external id across repeated sync cycles without duplicate inserts of distinct rows', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    const issue = {
      externalId: '36',
      title: 'mine',
      url: 'https://github.com/a/b/issues/36',
      labels: ['ai'],
      createdAt: '2026-01-02T00:00:00Z',
      kind: 'issue' as const,
      assignees: [{ id: '1', login: 'me' }],
    }
    vi.mocked(listGitHubAiIssues).mockResolvedValue([issue])

    const repo = {
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never

    await syncRepositoryQueue(repo)
    await syncRepositoryQueue(repo)

    const issueInserts = inserted.filter((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'issue',
    ) as Array<{ externalId: string }>
    expect(issueInserts).toHaveLength(2)
    expect(issueInserts.every((i) => i.externalId === '36')).toBe(true)
  })

  // Blocking PR without assignee still persisted for open-PR gating
  it('keeps unassigned ai-pr open PR as a blocker but not as next work', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubAiPullRequests).mockResolvedValue([
      {
        externalId: '99',
        title: 'blocker',
        url: 'https://github.com/a/b/pull/99',
        labels: ['ai-pr'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'pull_request',
        sourceBranch: 'ai/issue-1',
        assignees: [],
        author: { id: '1', login: 'me' },
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)
    expect(result.ok).toBe(true)
    const pr = inserted.find((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'pull_request',
    ) as { externalId: string, assignees: unknown[] }
    expect(pr.externalId).toBe('99')
    expect(pr.assignees).toEqual([])
  })

  it('does not keep unassigned ai-pr PR created by another user as a blocker', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c1', accountId: '1', accountLogin: 'me', instanceUrl: 'https://github.com' },
    } as never)
    vi.mocked(listGitHubAiPullRequests).mockResolvedValue([
      {
        externalId: '88',
        title: 'someone else',
        url: 'https://github.com/a/b/pull/88',
        labels: ['ai-pr'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'pull_request',
        sourceBranch: 'ai/issue-2',
        assignees: [],
        author: { id: '9', login: 'other' },
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r1',
      name: 'a/b',
      forgeType: 'github',
      connectionId: 'c1',
      canonicalProjectIdentifier: 'a/b',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: null,
    } as never)
    expect(result.ok).toBe(true)
    const prs = inserted.filter((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'pull_request',
    )
    expect(prs).toHaveLength(0)
  })

  it('keeps unassigned ai-pr MR by configured user as a blocker; drops other authors', async () => {
    vi.mocked(ensureConnectionAccount).mockResolvedValue({
      token: 'tok',
      row: { id: 'c2', accountId: '42', accountLogin: 'me', instanceUrl: 'https://gitlab.example' },
    } as never)
    vi.mocked(listGitLabAiMergeRequests).mockResolvedValue([
      {
        externalId: '50',
        title: 'ours',
        url: 'https://gitlab.example/g/p/-/merge_requests/50',
        labels: ['ai-pr'],
        createdAt: '2026-01-01T00:00:00Z',
        kind: 'merge_request',
        sourceBranch: 'ai/issue-1',
        assignees: [],
        author: { id: '42', login: 'me' },
      },
      {
        externalId: '51',
        title: 'theirs',
        url: 'https://gitlab.example/g/p/-/merge_requests/51',
        labels: ['ai-pr'],
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'merge_request',
        sourceBranch: 'ai/issue-2',
        assignees: [],
        author: { id: '99', login: 'other' },
      },
    ])

    const result = await syncRepositoryQueue({
      id: 'r2',
      name: 'g/p',
      forgeType: 'gitlab',
      connectionId: 'c2',
      canonicalProjectIdentifier: 'g/p',
      providerRepoId: null,
      remoteUrl: null,
      instanceUrl: 'https://gitlab.example',
    } as never)
    expect(result.ok).toBe(true)
    const mrs = inserted.filter((v) =>
      v && typeof v === 'object' && (v as { kind?: string }).kind === 'merge_request',
    ) as Array<{ externalId: string }>
    expect(mrs.map((m) => m.externalId)).toEqual(['50'])
  })
})
