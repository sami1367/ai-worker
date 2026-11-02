import { describe, expect, it } from 'vitest'
import { isCodeContextSummaryAvailable } from '../../server/services/task-planning-context'

describe('isCodeContextSummaryAvailable', () => {
  it('treats unavailable stubs as missing', () => {
    expect(isCodeContextSummaryAvailable(null)).toBe(false)
    expect(isCodeContextSummaryAvailable('')).toBe(false)
    expect(isCodeContextSummaryAvailable(
      'Workspace is not cloned yet. Plan from the product description only; suggest the operator clone/sync the repository for richer code-aware tasks.',
    )).toBe(false)
    expect(isCodeContextSummaryAvailable('Workspace path is not a directory.')).toBe(false)
  })

  it('treats real tree summaries as available', () => {
    expect(isCodeContextSummaryAvailable(
      '## Repository file tree (sampled)\n- src/\n- package.json\n',
    )).toBe(true)
  })
})
