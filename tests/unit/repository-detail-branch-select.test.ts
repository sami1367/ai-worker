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
    expect(source).toMatch(/<USelect[\s\S]*v-if="branchOptions\.length"[\s\S]*:model-value="defaultBranch"/)
    expect(source).toMatch(/@update:model-value="onDefaultBranchSelect"/)
    expect(source).toMatch(/<UInput[\s\S]*v-else[\s\S]*v-model="defaultBranch"/)
  })

  it('uses a local defaultBranch draft so the select updates before Save', () => {
    expect(source).toContain("const defaultBranch = ref('')")
    expect(source).toContain('applySelectDraft')
    expect(source).toContain('onDefaultBranchSelect')
    expect(source).toContain('defaultBranch: defaultBranch.value')
  })

  it('does not offer a per-repository default AI provider picker', () => {
    expect(source).not.toContain('label="Default AI provider"')
    expect(source).not.toContain('defaultAiProvider')
    expect(source).not.toMatch(/Choose AI provider/i)
  })
})
