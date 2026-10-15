import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COLLABORATION_LINKS,
  CONTACT_LINKS,
  SITE,
  displayHref,
  linkIsConfigured,
} from '../../app/utils/site-links'

const root = resolve(__dirname, '../..')

describe('site links and license', () => {
  it('matches the repository LICENSE (Apache-2.0)', () => {
    const license = readFileSync(resolve(root, 'LICENSE'), 'utf8')
    expect(license).toMatch(/Apache License/i)
    expect(license).toMatch(/Version 2\.0/)
    expect(SITE.licenseSpdx).toBe('Apache-2.0')
    expect(SITE.licenseName).toMatch(/Apache License 2\.0/)
    expect(SITE.licenseUrl).toContain('/LICENSE')
  })

  it('exposes required contact channels with configured or placeholder values', () => {
    const ids = CONTACT_LINKS.map((l) => l.id)
    expect(ids).toEqual(expect.arrayContaining(['github', 'docs', 'email', 'website', 'linkedin']))
    for (const link of CONTACT_LINKS) {
      if (linkIsConfigured(link)) {
        expect(link.href.length).toBeGreaterThan(0)
      } else {
        expect(displayHref(link)).toMatch(/Not configured|placeholder|update app\/utils\/site-links/i)
      }
    }
  })

  it('keeps repository URL consistent', () => {
    expect(SITE.repositoryUrl).toBe('https://github.com/sami1367/ai-worker')
    const github = CONTACT_LINKS.find((l) => l.id === 'github')
    expect(github?.href).toBe(SITE.repositoryUrl)
  })

  it('keeps documentation URL consistent', () => {
    expect(SITE.docsUrl).toBe('http://vibeplus1.com/ai-worker')
    const docs = CONTACT_LINKS.find((l) => l.id === 'docs')
    expect(docs?.href).toBe(SITE.docsUrl)
  })

  it('includes optional collaboration links', () => {
    expect(COLLABORATION_LINKS.some((l) => l.id === 'issues')).toBe(true)
    expect(COLLABORATION_LINKS.some((l) => l.id === 'contribute')).toBe(true)
    expect(COLLABORATION_LINKS.some((l) => l.id === 'commercial')).toBe(true)
  })
})
