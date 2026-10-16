import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readPage(relativePath: string) {
  return readFileSync(resolve(__dirname, '../..', relativePath), 'utf8')
}

describe('secret form fields never prefill or display stored values', () => {
  it('setup bootstrap secret uses password input and starts empty', () => {
    const source = readPage('app/pages/setup.vue')
    expect(source).toMatch(/const bootstrapSecret = ref\(''\)/)
    expect(source).toMatch(/v-model="bootstrapSecret"\s+type="password"/)
    expect(source).not.toMatch(/bootstrapSecret\.value\s*=\s*[^'\n]+/)
  })

  it('provider secret draft starts empty with password masking', () => {
    const source = readPage('app/pages/providers.vue')
    expect(source).toMatch(/secret:\s*''/)
    expect(source).toMatch(/v-model="draftFor\(p\.providerType\)\.secret"\s+type="password"/)
    expect(source).toMatch(/autocomplete="off"/)
    // Never assign API/secret response values into the draft input
    expect(source).not.toMatch(/d\.secret\s*=\s*p\./)
    expect(source).not.toMatch(/drafts\[.*\]\.secret\s*=\s*[^'\n]+/)
  })

  it('GitHub and GitLab token forms start empty with password masking', () => {
    const source = readPage('app/pages/connections/index.vue')
    expect(source).toMatch(/token:\s*''/)
    expect(source).toMatch(/v-model="githubForm\.token"\s+type="password"/)
    expect(source).toMatch(/v-model="gitlabForm\.token"\s+type="password"/)
    expect(source).not.toMatch(/githubForm\.token\s*=\s*c\./)
    expect(source).not.toMatch(/gitlabForm\.token\s*=\s*c\./)
  })
})
