import { describe, expect, it } from 'vitest'
import {
  extractJsonObject,
  formatTasksForChat,
  normalizeDraftTasks,
  parsePlanningStatusLine,
  stripPlanningStatusLine,
} from '../../server/services/task-planning-parse'

describe('task-planning-parse', () => {
  it('parses status lines from assistant replies', () => {
    expect(parsePlanningStatusLine('Need more info.\n\nStatus: need_clarification')).toBe('clarifying')
    expect(parsePlanningStatusLine('Ready.\nStatus: ready_to_generate')).toBe('ready_to_generate')
    expect(parsePlanningStatusLine('Tweaks.\nStatus: refining_draft')).toBe('draft')
    expect(parsePlanningStatusLine('no status')).toBe('clarifying')
  })

  it('strips status lines for display', () => {
    expect(stripPlanningStatusLine('Hello\n\nStatus: ready_to_generate')).toBe('Hello')
  })

  it('extracts JSON from fenced or raw model output', () => {
    const obj = extractJsonObject('```json\n{"tasks":[{"title":"A","body":"B"}]}\n```') as {
      tasks: Array<{ title: string }>
    }
    expect(obj.tasks[0]!.title).toBe('A')

    const raw = extractJsonObject('Here you go: {"tasks":[{"title":"X","body":"Y"}]} thanks') as {
      tasks: Array<{ title: string }>
    }
    expect(raw.tasks[0]!.title).toBe('X')
  })

  it('normalizes draft tasks and skips empty titles', () => {
    const tasks = normalizeDraftTasks({
      tasks: [
        { title: ' Add login ', body: 'Goal' },
        { title: '', body: 'skip' },
        { title: 'Only title' },
      ],
    })
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.title).toBe('Add login')
    expect(tasks[0]!.body).toBe('Goal')
    expect(tasks[0]!.localId).toBeTruthy()
    expect(tasks[1]!.body).toBe('Only title')
  })

  it('formats tasks for chat', () => {
    const text = formatTasksForChat([
      { localId: '1', title: 'One', body: 'Body one' },
      { localId: '2', title: 'Two', body: 'Body two' },
    ])
    expect(text).toContain('### 1. One')
    expect(text).toContain('### 2. Two')
  })
})
