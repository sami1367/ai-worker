import { describe, expect, it } from 'vitest'
import type { QueueItem } from '../../server/services/task-queue'
import {
  computeNextTask,
  computeRepoBlockReason,
  computeStatusReason,
  isNoChangeIssue,
} from '../../server/services/task-queue'

function baseItem(overrides: Partial<QueueItem> & Pick<QueueItem, 'id' | 'externalId' | 'kind' | 'labels' | 'phase'>): QueueItem {
  return {
    repositoryId: 'repo-1',
    repositoryName: 'owner/repo',
    forgeType: 'github',
    taskType: overrides.kind === 'issue' ? 'github_issue' : 'github_pr_implement',
    phaseLabel: 'Queued for AI',
    statusReason: null,
    title: 't',
    url: 'https://example.test',
    sourceBranch: null,
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    assignedWorker: null,
    isNext: false,
    ...overrides,
  }
}

describe('isNoChangeIssue', () => {
  it('detects no-change label case-insensitively', () => {
    expect(isNoChangeIssue(['ai', 'no-change'])).toBe(true)
    expect(isNoChangeIssue(['AI', 'No-Change'])).toBe(true)
    expect(isNoChangeIssue(['ai'])).toBe(false)
  })
})

describe('computeNextTask with open AI PR', () => {
  const openPr = baseItem({
    id: 'pr-1',
    externalId: '10',
    kind: 'pull_request',
    labels: ['ai-pr'],
    phase: 'completed',
    phaseLabel: 'AI PR created',
    sourceBranch: 'ai/issue-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  const implementIssue = baseItem({
    id: 'issue-2',
    externalId: '2',
    kind: 'issue',
    labels: ['ai'],
    phase: 'queued',
    phaseLabel: 'Queued for AI',
    createdAt: '2026-01-02T00:00:00.000Z',
  })

  const noChangeIssue = baseItem({
    id: 'issue-3',
    externalId: '3',
    kind: 'issue',
    labels: ['ai', 'no-change'],
    phase: 'queued',
    phaseLabel: 'Queued for AI answer',
    createdAt: '2026-01-03T00:00:00.000Z',
  })

  it('blocks implement issues when an AI-labeled PR is open', () => {
    const next = computeNextTask(
      [openPr, implementIssue],
      new Map([['repo-1', true]]),
    )
    expect(next).toBeNull()
  })

  it('allows no-change Q&A issues while an AI-labeled PR is open', () => {
    const next = computeNextTask(
      [openPr, implementIssue, noChangeIssue],
      new Map([['repo-1', true]]),
    )
    expect(next?.id).toBe('issue-3')
  })

  it('still blocks no-change when another issue is ai-working', () => {
    const working = baseItem({
      id: 'issue-9',
      externalId: '9',
      kind: 'issue',
      labels: ['ai-working'],
      phase: 'working',
      phaseLabel: 'AI working',
    })
    const next = computeNextTask(
      [working, noChangeIssue],
      new Map([['repo-1', true]]),
    )
    expect(next).toBeNull()
  })

  it('allows implement issues when blockOnOpenPr is false', () => {
    const next = computeNextTask(
      [openPr, implementIssue],
      new Map([['repo-1', false]]),
    )
    expect(next?.id).toBe('issue-2')
  })
})

describe('computeRepoBlockReason / computeStatusReason', () => {
  const openPr = baseItem({
    id: 'pr-1',
    externalId: '10',
    kind: 'pull_request',
    labels: ['ai-pr'],
    phase: 'completed',
    phaseLabel: 'AI PR created',
    sourceBranch: 'ai/issue-1',
  })

  const implementIssue = baseItem({
    id: 'issue-2',
    externalId: '2',
    kind: 'issue',
    labels: ['ai'],
    phase: 'queued',
    phaseLabel: 'Queued for AI',
  })

  const noChangeIssue = baseItem({
    id: 'issue-3',
    externalId: '3',
    kind: 'issue',
    labels: ['ai', 'no-change'],
    phase: 'queued',
    phaseLabel: 'Queued for AI answer',
  })

  const repo = {
    id: 'repo-1',
    name: 'owner/repo',
    forgeType: 'github' as const,
    blockOnOpenPr: true,
  }

  it('reports open-pr block kind when an AI PR is open', () => {
    const block = computeRepoBlockReason(repo, [openPr, implementIssue, noChangeIssue])
    expect(block.kind).toBe('open-pr')
    expect(block.reason).toContain('open AI-labeled pull request')
  })

  it('applies open-pr block reason to implement issues but not no-change', () => {
    const block = computeRepoBlockReason(repo, [openPr, implementIssue, noChangeIssue])
    const byId = new Map([['repo-1', block]])

    expect(computeStatusReason(implementIssue, [openPr, implementIssue, noChangeIssue], 'running', byId))
      .toBe(block.reason)

    const noChangeReason = computeStatusReason(
      noChangeIssue,
      [openPr, implementIssue, noChangeIssue],
      'running',
      byId,
    )
    expect(noChangeReason).not.toBe(block.reason)
    expect(noChangeReason).toMatch(/queued behind|Next —/)
  })

  it('still applies ai-working block to no-change issues', () => {
    const working = baseItem({
      id: 'issue-9',
      externalId: '9',
      kind: 'issue',
      labels: ['ai-working'],
      phase: 'working',
      phaseLabel: 'AI working',
    })
    const block = computeRepoBlockReason(repo, [working, noChangeIssue])
    expect(block.kind).toBe('ai-working')
    const byId = new Map([['repo-1', block]])
    expect(computeStatusReason(noChangeIssue, [working, noChangeIssue], 'running', byId))
      .toBe(block.reason)
  })

  it('reports gitlab open-pr wording for merge requests', () => {
    const mr = baseItem({
      id: 'mr-1',
      externalId: '5',
      kind: 'merge_request',
      forgeType: 'gitlab',
      taskType: 'gitlab_mr_implement',
      labels: ['ai-pr'],
      phase: 'completed',
      phaseLabel: 'AI PR created',
      sourceBranch: 'ai/issue-1',
    })
    const glRepo = {
      id: 'repo-1',
      name: 'group/project',
      forgeType: 'gitlab' as const,
      blockOnOpenPr: true,
    }
    const block = computeRepoBlockReason(glRepo, [mr])
    expect(block.kind).toBe('open-pr')
    expect(block.reason).toContain('open AI-labeled merge request')
  })

  it('returns null block when blockOnOpenPr is false or no blocker', () => {
    expect(computeRepoBlockReason({ ...repo, blockOnOpenPr: false }, [openPr]).kind).toBeNull()
    expect(computeRepoBlockReason(repo, [implementIssue]).kind).toBeNull()
  })

  it('surfaces open-pr reason on the blocking PR itself', () => {
    const block = computeRepoBlockReason(repo, [openPr])
    const byId = new Map([['repo-1', block]])
    expect(computeStatusReason(openPr, [openPr], 'running', byId)).toBe(block.reason)
  })

  it('covers remaining status-reason branches used with RepoBlockInfo', () => {
    const emptyBlock = new Map([['repo-1', { reason: null, kind: null } as const]])
    const working = baseItem({
      id: 'issue-w',
      externalId: '8',
      kind: 'issue',
      labels: ['ai-working'],
      phase: 'working',
      phaseLabel: 'AI working',
    })
    expect(computeStatusReason(working, [working], 'running', emptyBlock)).toBeNull()

    const failed = baseItem({
      id: 'issue-f',
      externalId: '4',
      kind: 'issue',
      labels: ['ai-failed'],
      phase: 'failed',
      phaseLabel: 'AI failed',
    })
    expect(computeStatusReason(failed, [failed], 'running', emptyBlock))
      .toBe('Not working — labeled ai-failed')

    const answered = baseItem({
      id: 'issue-a',
      externalId: '5',
      kind: 'issue',
      labels: ['ai-answered', 'no-change'],
      phase: 'completed',
      phaseLabel: 'AI answered',
    })
    expect(computeStatusReason(answered, [answered], 'running', emptyBlock))
      .toContain('ai-answered')

    const donePr = baseItem({
      id: 'issue-p',
      externalId: '6',
      kind: 'issue',
      labels: ['ai-pr'],
      phase: 'completed',
      phaseLabel: 'AI PR created',
    })
    expect(computeStatusReason(donePr, [donePr], 'running', emptyBlock))
      .toContain('ai-pr')

    const reviewed = baseItem({
      id: 'pr-r',
      externalId: '7',
      kind: 'pull_request',
      labels: ['ai-reviewed'],
      phase: 'completed',
      phaseLabel: 'AI reviewed',
      taskType: 'github_pr_review',
    })
    expect(computeStatusReason(reviewed, [reviewed], 'running', emptyBlock))
      .toContain('ai-reviewed')

    expect(computeStatusReason(implementIssue, [implementIssue], 'stopped', emptyBlock))
      .toBe('Not working — worker is stopped')
    expect(computeStatusReason(implementIssue, [implementIssue], 'unknown', emptyBlock))
      .toContain('heartbeat')

    const nextItem = { ...noChangeIssue, isNext: true }
    expect(computeStatusReason(nextItem, [openPr, nextItem], 'running', new Map([['repo-1', {
      reason: 'open pr block',
      kind: 'open-pr' as const,
    }]]))).toBe('Next — waiting for worker to pick up')

    const busyReason = computeStatusReason(
      noChangeIssue,
      [working, noChangeIssue],
      'running',
      emptyBlock,
    )
    expect(busyReason).toContain('repository busy')
  })
})

describe('computeNextTask sort among eligible no-change issues', () => {
  it('picks the older eligible no-change issue first', () => {
    const openPr = baseItem({
      id: 'pr-1',
      externalId: '10',
      kind: 'pull_request',
      labels: ['ai-pr'],
      phase: 'completed',
      phaseLabel: 'AI PR created',
      sourceBranch: 'ai/issue-1',
    })
    const older = baseItem({
      id: 'issue-older',
      externalId: '2',
      kind: 'issue',
      labels: ['ai', 'no-change'],
      phase: 'queued',
      phaseLabel: 'Queued for AI answer',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    const newer = baseItem({
      id: 'issue-newer',
      externalId: '3',
      kind: 'issue',
      labels: ['ai', 'no-change'],
      phase: 'queued',
      phaseLabel: 'Queued for AI answer',
      createdAt: '2026-01-04T00:00:00.000Z',
    })
    const next = computeNextTask(
      [openPr, newer, older],
      new Map([['repo-1', true]]),
    )
    expect(next?.id).toBe('issue-older')
  })
})
