import { randomUUID } from 'node:crypto'
import type { TaskPlanningDraftTask } from '#db/schema'

export const MAX_DRAFT_TASKS = 25

export function parsePlanningStatusLine(text: string): 'clarifying' | 'ready_to_generate' | 'draft' {
  const m = text.match(/Status:\s*(need_clarification|ready_to_generate|refining_draft)/i)
  if (!m) return 'clarifying'
  const v = m[1]!.toLowerCase()
  if (v === 'ready_to_generate') return 'ready_to_generate'
  if (v === 'refining_draft') return 'draft'
  return 'clarifying'
}

export function stripPlanningStatusLine(text: string): string {
  return text.replace(/\n*Status:\s*(need_clarification|ready_to_generate|refining_draft)\s*$/i, '').trim()
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) return JSON.parse(fence[1].trim())
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('No JSON object in model response')
}

export function normalizeDraftTasks(raw: unknown): TaskPlanningDraftTask[] {
  if (!raw || typeof raw !== 'object') return []
  const tasks = (raw as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) return []
  const out: TaskPlanningDraftTask[] = []
  for (const item of tasks.slice(0, MAX_DRAFT_TASKS)) {
    if (!item || typeof item !== 'object') continue
    const title = String((item as { title?: unknown }).title || '').trim()
    const body = String((item as { body?: unknown }).body || '').trim()
    if (!title) continue
    out.push({
      localId: randomUUID(),
      title: title.slice(0, 200),
      body: (body || title).slice(0, 60000),
    })
  }
  return out
}

export function formatTasksForChat(tasks: TaskPlanningDraftTask[]): string {
  if (!tasks.length) return '_No tasks generated._'
  return tasks.map((t, i) => {
    const bodyPreview = t.body.length > 600 ? `${t.body.slice(0, 600)}…` : t.body
    return `### ${i + 1}. ${t.title}\n\n${bodyPreview}`
  }).join('\n\n---\n\n')
}
