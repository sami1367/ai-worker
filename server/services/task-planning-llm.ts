import { eq } from 'drizzle-orm'
import { providerConfigs } from '#db/schema'
import { getDb } from '#utils/db'
import { AppError } from '#utils/errors'
import { decryptSecret } from '#utils/crypto'
import { safeFetch } from '#utils/safe-fetch'
import { redactSecrets } from '#utils/redact'
import {
  normalizeAnthropicWorkspaceId,
  resolveAnthropicCustomHeaders,
} from './provider-credentials'
import { normalizeProviderModel, providerModelFromConfig } from './providers'

export type PlanningLlmMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type PlanningProvider = {
  providerType: 'claude' | 'codex' | 'gemini'
  model: string
  displayName: string
}

type ResolvedCreds = PlanningProvider & {
  apiKey: string
  anthropicHeaders?: string
}

const PLANNING_ORDER: Array<'claude' | 'codex' | 'gemini'> = ['claude', 'codex', 'gemini']

function encryptionKey(): string {
  return process.env.SECRET_ENCRYPTION_KEY || ''
}

function envKeyFor(providerType: 'claude' | 'codex' | 'gemini'): string {
  if (providerType === 'claude') return process.env.ANTHROPIC_API_KEY || ''
  if (providerType === 'codex') return process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || ''
  return process.env.GEMINI_API_KEY || ''
}

/**
 * Resolve an HTTP-capable planning provider (Claude / Codex / Gemini).
 * Cursor and Copilot CLIs are not used for Create Tasks chat.
 */
export async function resolvePlanningProvider(
  preferType?: string | null,
): Promise<ResolvedCreds> {
  const db = getDb()
  const rows = await db.select().from(providerConfigs)
  const key = encryptionKey()

  const candidates: ResolvedCreds[] = []

  for (const type of PLANNING_ORDER) {
    const row = rows.find((r) => r.providerType === type)
    if (!row || !row.isEnabled) continue

    let apiKey = ''
    if (row.secretCiphertext && key) {
      try {
        apiKey = decryptSecret(row.secretCiphertext, key)
      } catch {
        apiKey = ''
      }
    }
    if (!apiKey) apiKey = envKeyFor(type)
    if (!apiKey) continue

    if (type === 'claude') {
      const credType = String((row.config as Record<string, unknown>)?.credentialType || 'anthropic_api_key')
      // Messages API needs an Anthropic API key, not a Claude OAuth token.
      if (credType === 'claude_oauth_token' && !apiKey.startsWith('sk-ant')) {
        const envAnt = process.env.ANTHROPIC_API_KEY || ''
        if (!envAnt) continue
        apiKey = envAnt
      }
      const workspaceId = normalizeAnthropicWorkspaceId(
        (row.config as Record<string, unknown>)?.anthropicWorkspaceId,
      )
      const anthropicHeaders = resolveAnthropicCustomHeaders({
        apiKeyPresent: true,
        workspaceId,
        envWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
        envCustomHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS,
      })
      candidates.push({
        providerType: 'claude',
        model: providerModelFromConfig(row.config as Record<string, unknown>) || 'claude-sonnet-4-20250514',
        displayName: row.displayName,
        apiKey,
        anthropicHeaders: anthropicHeaders || undefined,
      })
      continue
    }

    if (type === 'codex') {
      candidates.push({
        providerType: 'codex',
        model: providerModelFromConfig(row.config as Record<string, unknown>) || 'gpt-4.1',
        displayName: row.displayName,
        apiKey,
      })
      continue
    }

    candidates.push({
      providerType: 'gemini',
      model: providerModelFromConfig(row.config as Record<string, unknown>) || 'gemini-2.5-flash',
      displayName: row.displayName,
      apiKey,
    })
  }

  if (!candidates.length) {
    throw new AppError(
      400,
      'Create Tasks needs Claude, Codex, or Gemini connected with an API key. Cursor and Copilot CLIs cannot power this chat. Open Providers and connect one of those three.',
      'planning_provider_missing',
    )
  }

  const preferred = preferType
    ? candidates.find((c) => c.providerType === preferType)
    : null
  const defaultRow = rows.find((r) => r.isDefault && r.isEnabled)
  const fromDefault = defaultRow
    ? candidates.find((c) => c.providerType === defaultRow.providerType)
    : null

  return preferred || fromDefault || candidates[0]!
}

export async function callPlanningLlm(opts: {
  messages: PlanningLlmMessage[]
  preferProviderType?: string | null
}): Promise<{ text: string, provider: PlanningProvider }> {
  const creds = await resolvePlanningProvider(opts.preferProviderType)
  const text = creds.providerType === 'claude'
    ? await callAnthropic(creds, opts.messages)
    : creds.providerType === 'codex'
      ? await callOpenAi(creds, opts.messages)
      : await callGemini(creds, opts.messages)

  return {
    text,
    provider: {
      providerType: creds.providerType,
      model: normalizeProviderModel(creds.model) || creds.model,
      displayName: creds.displayName,
    },
  }
}

async function callAnthropic(
  creds: ResolvedCreds,
  messages: PlanningLlmMessage[],
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const chat = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': creds.apiKey,
    'anthropic-version': '2023-06-01',
    'User-Agent': 'ai-worker-platform',
  }
  if (creds.anthropicHeaders) {
    // Anthropic custom headers are "name: value" lines; workspace is the common case.
    for (const line of creds.anthropicHeaders.split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }
  }

  const res = await safeFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: creds.model,
      max_tokens: 4096,
      system: system || undefined,
      messages: chat,
    }),
    timeoutMs: 90_000,
    expectedOrigin: 'https://api.anthropic.com',
  })

  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(
      502,
      `Anthropic API error (${res.status}): ${text.slice(0, 240)}`,
      'planning_llm_error',
    )
  }

  const data = await res.json() as {
    content?: Array<{ type?: string, text?: string }>
  }
  const parts = (data.content || [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => String(c.text))
  const out = parts.join('\n').trim()
  if (!out) throw new AppError(502, 'Anthropic returned an empty response', 'planning_llm_empty')
  return out
}

async function callOpenAi(
  creds: ResolvedCreds,
  messages: PlanningLlmMessage[],
): Promise<string> {
  const res = await safeFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.apiKey}`,
      'User-Agent': 'ai-worker-platform',
    },
    body: JSON.stringify({
      model: creds.model,
      temperature: 0.3,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    timeoutMs: 90_000,
    expectedOrigin: 'https://api.openai.com',
  })

  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(
      502,
      `OpenAI API error (${res.status}): ${text.slice(0, 240)}`,
      'planning_llm_error',
    )
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const out = String(data.choices?.[0]?.message?.content || '').trim()
  if (!out) throw new AppError(502, 'OpenAI returned an empty response', 'planning_llm_empty')
  return out
}

async function callGemini(
  creds: ResolvedCreds,
  messages: PlanningLlmMessage[],
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  const model = encodeURIComponent(creds.model)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-goog-api-key': creds.apiKey,
      'User-Agent': 'ai-worker-platform',
    },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    }),
    timeoutMs: 90_000,
    expectedOrigin: 'https://generativelanguage.googleapis.com',
  })

  if (!res.ok) {
    const text = redactSecrets(await res.text())
    throw new AppError(
      502,
      `Gemini API error (${res.status}): ${text.slice(0, 240)}`,
      'planning_llm_error',
    )
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const parts = data.candidates?.[0]?.content?.parts || []
  const out = parts.map((p) => p.text || '').join('').trim()
  if (!out) throw new AppError(502, 'Gemini returned an empty response', 'planning_llm_empty')
  return out
}

/** Load provider type string from DB for a repository preference. */
export async function planningProviderForRepo(defaultAiProvider?: string | null) {
  if (defaultAiProvider === 'claude' || defaultAiProvider === 'codex' || defaultAiProvider === 'gemini') {
    return defaultAiProvider
  }
  // Prefer default connected planning provider when repo override is Cursor/Copilot.
  const [row] = await getDb().select().from(providerConfigs)
    .where(eq(providerConfigs.isDefault, true)).limit(1)
  if (row?.providerType === 'claude' || row?.providerType === 'codex' || row?.providerType === 'gemini') {
    return row.providerType
  }
  return null
}
