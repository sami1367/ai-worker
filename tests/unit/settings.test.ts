import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const settingsSchema = z.object({
  pollIntervalSeconds: z.number().int().min(15).max(3600).default(30),
  defaultAiProvider: z.enum(['cursor', 'claude', 'codex', 'gemini']).default('cursor'),
})

describe('settings schema', () => {
  it('applies defaults', () => {
    const s = settingsSchema.parse({})
    expect(s.pollIntervalSeconds).toBe(30)
    expect(s.defaultAiProvider).toBe('cursor')
  })

  it('rejects out of range poll interval', () => {
    expect(() => settingsSchema.parse({ pollIntervalSeconds: 1 })).toThrow()
  })
})
