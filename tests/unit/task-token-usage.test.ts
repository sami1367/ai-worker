import { describe, expect, it } from 'vitest'
import { extractTaskTokenUsage } from '../../server/services/tasks'

describe('extractTaskTokenUsage', () => {
  it('reads Cursor camelCase usage from resultMetadata.usage', () => {
    expect(extractTaskTokenUsage({
      branch: 'ai/issue-12',
      usage: {
        inputTokens: 5749,
        outputTokens: 25,
        cacheReadTokens: 9728,
        cacheWriteTokens: 0,
        totalTokens: 5774,
      },
    })).toEqual({
      inputTokens: 5749,
      outputTokens: 25,
      cacheReadTokens: 9728,
      cacheWriteTokens: 0,
      totalTokens: 5774,
      totalCostUsd: null,
    })
  })

  it('reads Claude snake_case usage and cost', () => {
    expect(extractTaskTokenUsage({
      usage: {
        input_tokens: 1500,
        output_tokens: 420,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 10,
        total_cost_usd: 0.0042,
      },
    })).toEqual({
      inputTokens: 1500,
      outputTokens: 420,
      cacheReadTokens: 800,
      cacheWriteTokens: 10,
      totalTokens: 1920,
      totalCostUsd: 0.0042,
    })
  })

  it('returns null when usage is missing or zeroed', () => {
    expect(extractTaskTokenUsage({})).toBeNull()
    expect(extractTaskTokenUsage({ usage: {} })).toBeNull()
    expect(extractTaskTokenUsage(null)).toBeNull()
  })
})
