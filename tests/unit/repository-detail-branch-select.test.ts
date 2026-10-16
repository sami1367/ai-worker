import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('repository detail target branch select', () => {
  const source = readFileSync(resolve(__dirname, '../../app/pages/repositories/[id].vue'), 'utf8')

  it('loads branches from the repository branches API', () => {
    expect(source).toContain('/api/v1/repositories/${id.value}/branches')
    expect(source).toContain('loadBranches')
    expect(source).toContain('branchOptions')
  })

  it('renders a dropdown when forge branches are available, otherwise a text input', () => {
    expect(source).toContain('label="PR / MR target branch"')
    expect(source).toMatch(/<USelect[\s\S]*v-if="branchOptions\.length"[\s\S]*v-model="data\.defaultBranch"/)
    expect(source).toMatch(/<UInput[\s\S]*v-else[\s\S]*v-model="data\.defaultBranch"/)
  })
})
