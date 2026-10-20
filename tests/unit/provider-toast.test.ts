import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProviderToast } from '../../app/utils/provider-toast'

describe('buildProviderToast', () => {
  it('returns success color by default', () => {
    expect(buildProviderToast('Claude Code CLI disabled')).toEqual({
      title: 'Claude Code CLI disabled',
      color: 'success',
    })
  })

  it('returns success when error is explicitly false', () => {
    expect(buildProviderToast('Cursor enabled', false)).toEqual({
      title: 'Cursor enabled',
      color: 'success',
    })
  })

  it('returns error color when error is true', () => {
    expect(buildProviderToast('Connect failed', true)).toEqual({
      title: 'Connect failed',
      color: 'error',
    })
  })
})

describe('providers page toast notifications', () => {
  const source = readFileSync(resolve(__dirname, '../../app/pages/providers.vue'), 'utf8')

  it('uses Nuxt UI toast instead of an inline UAlert for change feedback', () => {
    expect(source).toContain('useToast()')
    expect(source).toContain('buildProviderToast')
    expect(source).toMatch(/function notify\(title: string, error = false\)/)
    expect(source).toContain('toast.add(buildProviderToast(title, error))')
    expect(source).not.toMatch(/<UAlert[\s\S]*v-if="message"/)
    expect(source).not.toMatch(/const message = ref\(''\)/)
    expect(source).not.toMatch(/const messageError = ref\(/)
  })

  it('routes enable/disable and connect feedback through notify', () => {
    expect(source).toMatch(/notify\(enabled \? `\$\{p\.displayName\} enabled`/)
    expect(source).toMatch(/notify\(`\$\{p\.displayName\} connected/)
    expect(source).toMatch(/notify\(e\?\.data\?\.message \|\| 'Connect failed', true\)/)
  })
})
