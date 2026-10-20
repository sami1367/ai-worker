import { describe, expect, it } from 'vitest'
import { applySelectDraft } from '../../app/utils/repository-detail-select'

describe('applySelectDraft', () => {
  it('accepts a plain string selection', () => {
    expect(applySelectDraft('develop', 'main')).toBe('develop')
  })

  it('accepts a { value } item object from USelect', () => {
    expect(applySelectDraft({ label: 'develop', value: 'develop' }, 'main')).toBe('develop')
  })

  it('keeps the previous draft for unsupported payloads', () => {
    expect(applySelectDraft(undefined, 'main')).toBe('main')
    expect(applySelectDraft(null, 'main')).toBe('main')
    expect(applySelectDraft(42, 'main')).toBe('main')
    expect(applySelectDraft({ label: 'x' }, 'main')).toBe('main')
  })
})
