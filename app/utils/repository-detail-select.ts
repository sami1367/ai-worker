/**
 * Normalize a USelect @update:model-value payload to a draft string so the
 * control shows the new choice immediately (before Save persists it).
 */
export function applySelectDraft(next: unknown, previous: string): string {
  if (typeof next === 'string') return next
  if (next && typeof next === 'object' && typeof (next as { value?: unknown }).value === 'string') {
    return (next as { value: string }).value
  }
  return previous
}
