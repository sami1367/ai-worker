import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROMPT_CATALOG } from '../../server/services/prompts'

function listTxtFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listTxtFiles(join(dir, entry.name), rel))
    else if (entry.isFile() && entry.name.endsWith('.txt')) out.push(rel)
  }
  return out.sort()
}

describe('prompt catalog', () => {
  it('covers every seed .txt under worker/prompts', () => {
    const seedDir = join(process.cwd(), 'worker/prompts')
    const onDisk = listTxtFiles(seedDir)
    const catalog = PROMPT_CATALOG.map((e) => e.path).sort()
    expect(catalog).toEqual(onDisk)
  })

  it('uses unique paths', () => {
    const paths = PROMPT_CATALOG.map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
  })
})
