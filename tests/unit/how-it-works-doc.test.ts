import { describe, expect, it } from 'vitest'
import { en } from '../../app/locales/en'
import { forgePracticeKeys, labelLifecycleSections } from '../../app/utils/how-it-works-doc'

describe('how-it-works forge / label lifecycle docs', () => {
  it('lists practice guidance keys that exist in English messages', () => {
    expect(forgePracticeKeys).toHaveLength(4)
    for (const key of forgePracticeKeys) {
      expect(en[key]?.trim().length).toBeGreaterThan(0)
    }
  })

  it('documents implement, Q&A, and review label lifecycles', () => {
    expect(labelLifecycleSections).toHaveLength(3)
    for (const section of labelLifecycleSections) {
      expect(en[section.heading]?.trim().length).toBeGreaterThan(0)
      expect(en[section.body]?.trim().length).toBeGreaterThan(0)
    }

    expect(en['howItWorks.lifecycle.implement.body']).toContain('ai-working')
    expect(en['howItWorks.lifecycle.implement.body']).toContain('ai-pr')
    expect(en['howItWorks.lifecycle.implement.body']).toContain('ai-failed')
    expect(en['howItWorks.lifecycle.qa.body']).toContain('ai-answered')
    expect(en['howItWorks.lifecycle.qa.body']).toContain('no-change')
    expect(en['howItWorks.lifecycle.review.body']).toContain('ai-reviewing')
    expect(en['howItWorks.lifecycle.review.body']).toContain('ai-reviewed')
  })

  it('explains how to work in the forge and ties labels to the lifecycle', () => {
    expect(en['howItWorks.forge.intro']).toMatch(/GitHub|GitLab/)
    expect(en['howItWorks.forge.practice.heading'].length).toBeGreaterThan(0)
    expect(en['howItWorks.labels.intro']).toContain('ai-working')
    expect(en['howItWorks.labels.intro']).toContain('lifecycle')
  })
})
