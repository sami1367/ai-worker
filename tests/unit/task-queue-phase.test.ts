import { describe, expect, it } from 'vitest'

/** Mirrors classifyPhase in server/services/task-queue.ts for regression coverage. */
function classifyPhase(
  labels: string[],
  kind: 'issue' | 'pull_request' | 'merge_request',
): { phase: string, taskTypeHint: 'implement' | 'review' } {
  const set = new Set(labels.map((l) => l.toLowerCase()))

  if (kind === 'pull_request' || kind === 'merge_request') {
    if (set.has('ai-reviewing')) return { phase: 'reviewing', taskTypeHint: 'review' }
    if (set.has('ai-review-failed')) return { phase: 'failed', taskTypeHint: 'review' }
    if (set.has('ai-reviewed')) return { phase: 'completed', taskTypeHint: 'review' }
    if (set.has('ai-review')) return { phase: 'review_queued', taskTypeHint: 'review' }
  }

  if (set.has('ai-working')) return { phase: 'working', taskTypeHint: 'implement' }
  if (set.has('ai-failed')) return { phase: 'failed', taskTypeHint: 'implement' }
  if (set.has('ai-answered')) return { phase: 'completed', taskTypeHint: 'implement' }
  if (set.has('ai-pr')) return { phase: 'completed', taskTypeHint: 'implement' }
  if (set.has('ai')) return { phase: 'queued', taskTypeHint: 'implement' }

  return { phase: 'queued', taskTypeHint: kind === 'issue' ? 'implement' : 'review' }
}

describe('task queue phase classification', () => {
  it('classifies issue implement labels', () => {
    expect(classifyPhase(['ai'], 'issue').phase).toBe('queued')
    expect(classifyPhase(['ai-working'], 'issue').phase).toBe('working')
    expect(classifyPhase(['ai-pr'], 'issue').phase).toBe('completed')
    expect(classifyPhase(['ai-failed'], 'issue').phase).toBe('failed')
  })

  it('classifies no-change answer labels', () => {
    expect(classifyPhase(['ai', 'no-change'], 'issue').phase).toBe('queued')
    expect(classifyPhase(['ai-working', 'no-change'], 'issue').phase).toBe('working')
    expect(classifyPhase(['ai-answered', 'no-change'], 'issue').phase).toBe('completed')
    expect(classifyPhase(['ai-failed', 'no-change'], 'issue').phase).toBe('failed')
  })

  it('classifies PR review labels ahead of implement labels', () => {
    expect(classifyPhase(['ai-review'], 'pull_request')).toEqual({
      phase: 'review_queued',
      taskTypeHint: 'review',
    })
    expect(classifyPhase(['ai-reviewing'], 'pull_request').phase).toBe('reviewing')
    expect(classifyPhase(['ai-reviewed'], 'merge_request').phase).toBe('completed')
    expect(classifyPhase(['ai'], 'pull_request')).toEqual({
      phase: 'queued',
      taskTypeHint: 'implement',
    })
  })
})
