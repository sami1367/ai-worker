const SECRET_PATTERNS: RegExp[] = [
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/gi,
  /\b(access_token|refresh_token|client_secret|PRIVATE-TOKEN)\s*[:=]\s*["']?[^\s"'&]+/gi,
  /\/\/[^/\s]+:[^@/\s]+@/g,
]

export function redactSecrets(input: string | null | undefined, maxLen = 4000): string {
  if (!input) return ''
  let out = input
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]')
  }
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}…`
  }
  return out
}

export function scrubObjectSecrets<T extends Record<string, unknown>>(obj: T): T {
  const clone = structuredClone(obj)
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactSecrets(value, 2000)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (/token|secret|password|authorization|ciphertext/i.test(k)) {
          out[k] = '[REDACTED]'
        } else {
          out[k] = walk(v)
        }
      }
      return out
    }
    return value
  }
  return walk(clone) as T
}
