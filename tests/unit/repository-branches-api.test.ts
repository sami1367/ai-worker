import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('GET /api/v1/repositories/:id/branches', () => {
  const source = readFileSync(
    resolve(__dirname, '../../server/api/v1/repositories/[id]/branches.get.ts'),
    'utf8',
  )

  it('requires a user and delegates to listRepositoryBranches', () => {
    expect(source).toContain("import { listRepositoryBranches } from '#services/repositories'")
    expect(source).toContain('requireUser(event)')
    expect(source).toContain('listRepositoryBranches(id)')
    expect(source).toContain("statusMessage: 'Missing id'")
  })
})
