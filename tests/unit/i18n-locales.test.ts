import { describe, expect, it } from 'vitest'
import { en } from '../../app/locales/en'
import { LOCALE_CODES, messages } from '../../app/locales'
import type { MessageKey } from '../../app/locales/en'

describe('i18n locales', () => {
  const keys = Object.keys(en) as MessageKey[]

  it('exposes all requested UI locales', () => {
    expect(LOCALE_CODES).toEqual([
      'en', 'fa', 'es', 'fr', 'de', 'zh', 'pt', 'ar', 'hi', 'ru', 'ja', 'tr',
    ])
  })

  it('keeps every locale in sync with English keys', () => {
    for (const code of LOCALE_CODES) {
      const table = messages[code]
      expect(Object.keys(table).sort()).toEqual([...keys].sort())
      for (const key of keys) {
        expect(table[key]?.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('supports simple placeholder interpolation shape in English', () => {
    expect(en['dashboard.enabledCount']).toContain('{count}')
    expect(en['dashboard.usageDetail']).toContain('{total}')
  })

  it('includes How it works forge practice and label lifecycle keys', () => {
    const required = [
      'howItWorks.providers.heading',
      'howItWorks.providers.intro',
      'howItWorks.providers.cursor',
      'howItWorks.providers.claude',
      'howItWorks.providers.codex',
      'howItWorks.providers.gemini',
      'howItWorks.providers.copilot',
      'howItWorks.providers.codegraph',
      'howItWorks.forge.practice.heading',
      'howItWorks.forge.practice.item1',
      'howItWorks.forge.practice.item2',
      'howItWorks.forge.practice.item3',
      'howItWorks.forge.practice.item4',
      'howItWorks.lifecycle.heading',
      'howItWorks.lifecycle.intro',
      'howItWorks.lifecycle.implement.heading',
      'howItWorks.lifecycle.implement.body',
      'howItWorks.lifecycle.qa.heading',
      'howItWorks.lifecycle.qa.body',
      'howItWorks.lifecycle.review.heading',
      'howItWorks.lifecycle.review.body',
    ] as const
    for (const key of required) {
      expect(keys).toContain(key)
      expect(en[key].trim().length).toBeGreaterThan(0)
    }
  })
})
