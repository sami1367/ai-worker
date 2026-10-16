import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('finished tasks usage page', () => {
  const source = readFileSync(resolve(__dirname, '../../app/pages/tasks/usage.vue'), 'utf8')
  const dashboard = readFileSync(resolve(__dirname, '../../app/pages/index.vue'), 'utf8')
  const api = readFileSync(resolve(__dirname, '../../server/api/v1/runs/finished.get.ts'), 'utf8')

  it('lists finished task columns including tokens and a details link', () => {
    expect(source).toContain('`/api/v1/runs/finished?${qs.value}`')
    expect(source).toContain("t('dashboard.col.task')")
    expect(source).toContain("t('dashboard.col.duration')")
    expect(source).toContain("t('dashboard.col.provider')")
    expect(source).toContain("t('dashboard.col.tokens')")
    expect(source).toContain("t('dashboard.col.status')")
    expect(source).toContain('details')
    expect(source).toContain('`/tasks/${run.id}`')
  })

  it('links the dashboard finished-tasks section to the usage page', () => {
    expect(dashboard).toContain('to="/tasks/usage"')
    expect(dashboard).toContain("t('dashboard.finishedTasks')")
  })

  it('exposes a finished-runs API that supports all-time and window filters', () => {
    expect(api).toContain('listFinishedTaskRuns')
    expect(api).toContain('parseFinishedTaskRunsWindowHours')
    expect(api).toContain('windowHours')
  })
})
