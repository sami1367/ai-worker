import { describe, expect, it } from 'vitest'
import {
  normalizeAnthropicWorkspaceId,
  resolveAnthropicCustomHeaders,
} from '../../server/services/provider-credentials'

describe('normalizeAnthropicWorkspaceId', () => {
  it('trims and keeps wrkspc_ ids', () => {
    expect(normalizeAnthropicWorkspaceId('  wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ  '))
      .toBe('wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ')
  })

  it('returns empty for blank values', () => {
    expect(normalizeAnthropicWorkspaceId('')).toBe('')
    expect(normalizeAnthropicWorkspaceId('   ')).toBe('')
    expect(normalizeAnthropicWorkspaceId(null)).toBe('')
    expect(normalizeAnthropicWorkspaceId(undefined)).toBe('')
  })
})

describe('resolveAnthropicCustomHeaders', () => {
  it('returns empty when no API key is present', () => {
    expect(resolveAnthropicCustomHeaders({
      apiKeyPresent: false,
      workspaceId: 'wrkspc_abc',
    })).toBe('')
  })

  it('builds anthropic-workspace-id from config workspace id', () => {
    expect(resolveAnthropicCustomHeaders({
      apiKeyPresent: true,
      workspaceId: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ',
    })).toBe('anthropic-workspace-id: wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ')
  })

  it('prefers config workspace over env custom headers', () => {
    expect(resolveAnthropicCustomHeaders({
      apiKeyPresent: true,
      workspaceId: 'wrkspc_from_ui',
      envCustomHeaders: 'anthropic-workspace-id: wrkspc_from_env',
    })).toBe('anthropic-workspace-id: wrkspc_from_ui')
  })

  it('falls back to env custom headers when no workspace id', () => {
    expect(resolveAnthropicCustomHeaders({
      apiKeyPresent: true,
      envCustomHeaders: 'anthropic-workspace-id: wrkspc_env',
    })).toBe('anthropic-workspace-id: wrkspc_env')
  })
})
