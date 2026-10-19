<script setup lang="ts">
const { api } = useApi()
const { data, pending, refresh } = await useAsyncData('providers', () => api<any>('/api/v1/providers'))
const busy = ref('')
const message = ref('')
const messageError = ref(false)
const showAuthGuide = ref(true)

type Draft = {
  secret: string
  credentialType: 'anthropic_api_key' | 'claude_oauth_token'
  anthropicWorkspaceId: string
  model: string
  showConnect: boolean
}

/** Common model ids per provider; empty value = CLI default. */
const PROVIDER_MODEL_OPTIONS: Record<string, Array<{ label: string, value: string }>> = {
  cursor: [
    { label: 'Default (CLI)', value: '' },
    { label: 'Composer 1', value: 'composer-1' },
    { label: 'Sonnet 4', value: 'sonnet-4' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'Opus 4.1', value: 'opus-4.1' },
  ],
  claude: [
    { label: 'Default (CLI)', value: '' },
    { label: 'Sonnet', value: 'sonnet' },
    { label: 'Opus', value: 'opus' },
    { label: 'Haiku', value: 'haiku' },
  ],
  codex: [
    { label: 'Default (CLI)', value: '' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'o3', value: 'o3' },
    { label: 'o4-mini', value: 'o4-mini' },
  ],
  gemini: [
    { label: 'Default (CLI)', value: '' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
  ],
  copilot: [
    { label: 'Default (CLI)', value: '' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'Claude Sonnet 4', value: 'claude-sonnet-4' },
  ],
}

const CLAUDE_CREDENTIAL_ITEMS = [
  { label: 'Anthropic API key (recommended)', value: 'anthropic_api_key' },
  { label: 'Claude OAuth token (subscription)', value: 'claude_oauth_token' },
]

const drafts = reactive<Record<string, Draft>>({})

function draftFor(providerType: string): Draft {
  if (!drafts[providerType]) {
    drafts[providerType] = {
      secret: '',
      credentialType: 'anthropic_api_key',
      anthropicWorkspaceId: '',
      model: '',
      showConnect: false,
    }
  }
  return drafts[providerType]
}

function modelOptionsFor(providerType: string, selected: string) {
  const base = PROVIDER_MODEL_OPTIONS[providerType] || [{ label: 'Default (CLI)', value: '' }]
  if (selected && !base.some((item) => item.value === selected)) {
    return [...base, { label: selected, value: selected }]
  }
  return base
}

function claudeConfigPatch(d: Draft): Record<string, unknown> {
  return {
    credentialType: d.credentialType,
    anthropicWorkspaceId: d.credentialType === 'anthropic_api_key'
      ? d.anthropicWorkspaceId.trim()
      : '',
  }
}

watchEffect(() => {
  for (const p of data.value?.items || []) {
    const d = draftFor(p.providerType)
    const existing = p.config?.credentialType
    if (existing === 'claude_oauth_token' || existing === 'anthropic_api_key') {
      d.credentialType = existing
    }
    const model = typeof p.config?.model === 'string' ? p.config.model.trim() : ''
    d.model = model
    const workspaceId = typeof p.config?.anthropicWorkspaceId === 'string'
      ? p.config.anthropicWorkspaceId.trim()
      : ''
    d.anthropicWorkspaceId = workspaceId
  }
})

async function test(provider: string) {
  busy.value = provider
  message.value = ''
  messageError.value = false
  try {
    await api(`/api/v1/providers/${provider}/test`, { method: 'POST' })
    message.value = `Health check completed for ${provider}`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Test failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function isToggling(providerType: string) {
  return busy.value === `toggle-${providerType}`
}

const connectedEnabled = computed(() =>
  (data.value?.items || []).filter((p: any) => p.isEnabled && p.hasSecret),
)

/** Sole connected+enabled default cannot be unchecked — pick another provider first. */
function canUnsetDefault(p: any) {
  return connectedEnabled.value.some((o: any) => o.providerType !== p.providerType)
}

function canSetDefault(p: any) {
  return Boolean(p.isEnabled && p.hasSecret)
}

async function setEnabled(p: any, enabled: boolean) {
  if (p.isEnabled === enabled || isToggling(p.providerType)) return
  const prevEnabled = p.isEnabled
  const prevDefault = p.isDefault
  busy.value = `toggle-${p.providerType}`
  message.value = ''
  messageError.value = false
  // Optimistic update so the control feels immediate
  p.isEnabled = enabled
  if (!enabled) p.isDefault = false
  try {
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: { isEnabled: enabled },
    })
    message.value = enabled ? `${p.displayName} enabled` : `${p.displayName} disabled`
    await refresh()
    await refreshNuxtData('setup-readiness')
  } catch (e: any) {
    p.isEnabled = prevEnabled
    p.isDefault = prevDefault
    message.value = e?.data?.message || e?.statusMessage || `Failed to ${enabled ? 'enable' : 'disable'} ${p.displayName}`
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function setDefault(p: any, isDefault: boolean) {
  if (p.isDefault === isDefault || isToggling(p.providerType)) return
  if (isDefault && !canSetDefault(p)) {
    message.value = `Enable and connect ${p.displayName} before making it the default`
    messageError.value = true
    return
  }
  if (!isDefault && p.isDefault && !canUnsetDefault(p)) {
    message.value = 'At least one connected provider must remain the default. Enable and select another provider first.'
    messageError.value = true
    return
  }
  const prevByType = Object.fromEntries(
    (data.value?.items || []).map((item: any) => [item.providerType, item.isDefault]),
  )
  busy.value = `toggle-${p.providerType}`
  message.value = ''
  messageError.value = false
  // Optimistic radio-style update when selecting a new default
  if (isDefault) {
    for (const item of data.value?.items || []) {
      item.isDefault = item.providerType === p.providerType
    }
  } else {
    p.isDefault = false
  }
  try {
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: { isDefault },
    })
    message.value = isDefault
      ? `${p.displayName} set as default`
      : `${p.displayName} no longer default`
    await refresh()
  } catch (e: any) {
    for (const item of data.value?.items || []) {
      if (prevByType[item.providerType] !== undefined) {
        item.isDefault = prevByType[item.providerType]
      }
    }
    message.value = e?.data?.message || e?.statusMessage || 'Failed to update default provider'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function save(p: any) {
  busy.value = `save-${p.providerType}`
  message.value = ''
  messageError.value = false
  try {
    const d = draftFor(p.providerType)
    const config = {
      ...(p.config || {}),
      ...(p.providerType === 'claude' ? claudeConfigPatch(d) : {}),
      model: d.model.trim(),
    }
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: { config },
    })
    message.value = d.model.trim()
      ? `Saved ${p.displayName} (model: ${d.model.trim()})`
      : `Saved ${p.displayName} (default model)`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Save failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function credentialTypeForConnect(p: any, d: Draft): string {
  if (p.providerType === 'claude') return d.credentialType
  if (p.providerType === 'codex') return 'openai_api_key'
  if (p.providerType === 'gemini') return 'gemini_api_key'
  if (p.providerType === 'copilot') return 'copilot_github_token'
  return 'cursor_api_key'
}

async function connect(p: any) {
  const d = draftFor(p.providerType)
  if (!d.secret.trim()) {
    message.value = 'Paste a credential before connecting'
    messageError.value = true
    return
  }
  busy.value = `connect-${p.providerType}`
  message.value = ''
  messageError.value = false
  try {
    const config = {
      ...(p.config || {}),
      credentialType: credentialTypeForConnect(p, d),
      model: d.model.trim(),
      ...(p.providerType === 'claude' ? claudeConfigPatch(d) : {}),
    }
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: {
        isEnabled: true,
        secret: d.secret.trim(),
        config,
      },
    })
    d.secret = ''
    d.showConnect = false
    message.value = `${p.displayName} connected. Credentials are encrypted and exported to the worker.`
    await refresh()
    await refreshNuxtData('setup-readiness')
    await test(p.providerType)
  } catch (e: any) {
    message.value = e?.data?.message || 'Connect failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function disconnect(p: any) {
  busy.value = `disconnect-${p.providerType}`
  message.value = ''
  messageError.value = false
  try {
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: { secret: null },
    })
    message.value = `${p.displayName} disconnected. Stored secret cleared.`
    await refresh()
    await refreshNuxtData('setup-readiness')
  } catch (e: any) {
    message.value = e?.data?.message || 'Disconnect failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function secretHint(p: any): string {
  if (p.providerType === 'cursor') {
    return 'Cursor API key (CURSOR_API_KEY). Create one in Cursor dashboard → Settings → API Keys.'
  }
  if (p.providerType === 'codex') {
    return 'OpenAI API key (OPENAI_API_KEY / CODEX_API_KEY) from platform.openai.com/api-keys'
  }
  if (p.providerType === 'gemini') {
    return 'Gemini API key (GEMINI_API_KEY) from aistudio.google.com/apikey'
  }
  if (p.providerType === 'copilot') {
    return 'Fine-grained GitHub PAT with Copilot Requests (COPILOT_GITHUB_TOKEN). Classic ghp_ tokens are not supported.'
  }
  const d = draftFor(p.providerType)
  return d.credentialType === 'claude_oauth_token'
    ? 'Output of `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN). Do not paste an sk-ant API key here.'
    : 'Anthropic API key (ANTHROPIC_API_KEY) from platform.claude.com — prefer a workspace-scoped key.'
}

function secretLabel(p: any): string {
  if (p.providerType === 'cursor') return 'Cursor API key'
  if (p.providerType === 'codex') return 'OpenAI API key'
  if (p.providerType === 'gemini') return 'Gemini API key'
  if (p.providerType === 'copilot') return 'Copilot GitHub token'
  const d = draftFor(p.providerType)
  return d.credentialType === 'claude_oauth_token' ? 'Claude OAuth token' : 'Anthropic API key'
}

function showClaudeWorkspaceField(p: any): boolean {
  return p.providerType === 'claude' && draftFor(p.providerType).credentialType === 'anthropic_api_key'
}

function claudeAuthSummary(p: any): string {
  const kind = p.config?.credentialType
  const ws = typeof p.config?.anthropicWorkspaceId === 'string' ? p.config.anthropicWorkspaceId.trim() : ''
  if (kind === 'claude_oauth_token') return 'Auth: OAuth token (subscription)'
  if (kind === 'anthropic_api_key' || p.hasSecret) {
    return ws
      ? `Auth: API key · workspace ${ws}`
      : 'Auth: API key · no workspace id (optional unless Anthropic requires it)'
  }
  return 'Auth: not connected'
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">AI providers</h1>
      <p class="mt-1 text-sm opacity-70">
        Enable and connect at least one agent, then set a default.
        Secrets are encrypted at rest and never shown again after save.
        You can also set the matching variables in compose
        <code class="text-xs">.env</code> (UI/DB values override env when both are set).
        See <code class="text-xs">docs/AI_PROVIDERS.md</code> in the repository for the full auth guide.
      </p>
    </div>

    <div class="aw-panel rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-display text-xl">How to connect each auth type</h2>
        <UButton size="xs" variant="ghost" @click="showAuthGuide = !showAuthGuide">
          {{ showAuthGuide ? 'Hide' : 'Show' }}
        </UButton>
      </div>
      <div v-if="showAuthGuide" class="space-y-4 text-sm opacity-80">
        <section class="space-y-1.5">
          <h3 class="font-medium text-base opacity-100">Claude Code</h3>
          <p>
            <strong class="opacity-100">Recommended — Anthropic API key:</strong>
            In
            <a href="https://platform.claude.com" class="underline" target="_blank" rel="noopener noreferrer">platform.claude.com</a>,
            open Workspaces, create or pick a workspace, then create an API key
            <em>scoped to that workspace</em>. On this page choose
            <strong class="opacity-100">Anthropic API key</strong>, paste
            <code class="text-xs">sk-ant-…</code>, and Connect.
          </p>
          <p>
            If Anthropic returns
            <em>“API key is not scoped to a workspace”</em>, paste the workspace id
            (<code class="text-xs">wrkspc_…</code> from the Workspaces table) into
            <strong class="opacity-100">Anthropic workspace ID</strong>, then Save or Connect again.
            That exports <code class="text-xs">ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: …</code>
            for the worker.
          </p>
          <p>
            <strong class="opacity-100">Alternative — Claude OAuth token:</strong>
            On a machine with Claude Code logged in, run
            <code class="text-xs">claude setup-token</code>, choose
            <strong class="opacity-100">Claude OAuth token</strong> here, and paste the token.
            Do <em>not</em> put an API key in the OAuth field. Headless runs omit
            <code class="text-xs">--bare</code> for OAuth so Claude Code can use the token.
          </p>
        </section>
        <section class="space-y-1.5">
          <h3 class="font-medium text-base opacity-100">Cursor / Codex / Gemini / Copilot</h3>
          <ul class="list-disc space-y-1 ps-5">
            <li>
              <strong class="opacity-100">Cursor</strong> —
              API key from Cursor dashboard settings →
              <code class="text-xs">CURSOR_API_KEY</code>.
            </li>
            <li>
              <strong class="opacity-100">Codex</strong> —
              OpenAI API key from platform.openai.com →
              <code class="text-xs">OPENAI_API_KEY</code> /
              <code class="text-xs">CODEX_API_KEY</code>.
            </li>
            <li>
              <strong class="opacity-100">Gemini</strong> —
              key from aistudio.google.com/apikey →
              <code class="text-xs">GEMINI_API_KEY</code>.
            </li>
            <li>
              <strong class="opacity-100">GitHub Copilot</strong> —
              fine-grained PAT with <em>Copilot Requests</em> →
              <code class="text-xs">COPILOT_GITHUB_TOKEN</code>
              (classic <code class="text-xs">ghp_</code> tokens are not supported; do not reuse forge
              <code class="text-xs">GITHUB_TOKEN</code>).
            </li>
          </ul>
        </section>
      </div>
    </div>

    <UAlert
      v-if="message"
      :title="message"
      :color="messageError ? 'error' : 'success'"
      variant="subtle"
    />
    <div v-if="pending && !data" class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <div v-for="i in 5" :key="i" class="aw-panel h-48 animate-pulse rounded-xl" />
    </div>
    <div v-else class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <div v-for="p in data?.items || []" :key="p.id" class="aw-panel space-y-3 rounded-xl p-4">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h2 class="font-display text-xl">{{ p.displayName }}</h2>
            <p class="text-sm opacity-60">{{ p.providerType }}</p>
          </div>
          <UBadge
            :color="p.healthStatus === 'healthy' ? 'success' : p.healthStatus === 'degraded' ? 'warning' : 'neutral'"
            variant="subtle"
          >
            {{ p.healthStatus }}
          </UBadge>
        </div>
        <p class="text-sm opacity-70">{{ p.healthMessage || 'No health check yet' }}</p>
        <p class="text-sm"><span class="opacity-60">Version:</span> {{ p.detectedVersion || 'unavailable' }}</p>
        <p class="text-sm">
          <span class="opacity-60">Connected:</span>
          <template v-if="p.secretSource === 'stored'">yes (secret stored)</template>
          <template v-else-if="p.secretSource === 'env'">yes (from environment / .env)</template>
          <template v-else>no</template>
        </p>
        <p v-if="p.providerType === 'claude'" class="text-sm opacity-70">
          {{ claudeAuthSummary(p) }}
        </p>
        <div class="flex flex-col gap-2">
          <USwitch
            :model-value="p.isEnabled"
            :loading="isToggling(p.providerType)"
            :disabled="isToggling(p.providerType)"
            label="Enabled"
            @update:model-value="(v: boolean) => setEnabled(p, v)"
          />
          <USwitch
            :model-value="p.isDefault"
            :loading="isToggling(p.providerType)"
            :disabled="isToggling(p.providerType) || !canSetDefault(p) || (p.isDefault && !canUnsetDefault(p))"
            label="Default provider"
            :description="p.isDefault && !canUnsetDefault(p)
              ? 'Required while this is the only connected provider'
              : !p.hasSecret
                ? 'Connect credentials first'
                : !p.isEnabled
                  ? 'Enable this provider first'
                  : undefined"
            @update:model-value="(v: boolean) => setDefault(p, v)"
          />
        </div>

        <UFormField
          label="Model"
          hint="Default uses the provider CLI model. Save to apply."
        >
          <USelect
            v-model="draftFor(p.providerType).model"
            :items="modelOptionsFor(p.providerType, draftFor(p.providerType).model)"
            class="w-full"
          />
        </UFormField>

        <!-- Claude workspace id is editable without re-pasting the secret -->
        <template v-if="p.providerType === 'claude' && !draftFor(p.providerType).showConnect">
          <UFormField
            v-if="draftFor(p.providerType).credentialType === 'anthropic_api_key'"
            label="Anthropic workspace ID"
            hint="Optional. Required when the API key is not workspace-scoped (wrkspc_… from Console → Workspaces)."
          >
            <UInput
              v-model="draftFor(p.providerType).anthropicWorkspaceId"
              autocomplete="off"
              class="w-full"
              placeholder="wrkspc_…"
            />
          </UFormField>
        </template>

        <div v-if="draftFor(p.providerType).showConnect" class="space-y-3 border-t border-default/40 pt-3">
          <UFormField
            v-if="p.providerType === 'claude'"
            label="Credential type"
            hint="API key is best for headless workers. OAuth is for Claude Pro/Max setup-token."
          >
            <USelect
              v-model="draftFor(p.providerType).credentialType"
              :items="CLAUDE_CREDENTIAL_ITEMS"
            />
          </UFormField>
          <UFormField :label="secretLabel(p)" :hint="secretHint(p)">
            <UInput
              v-model="draftFor(p.providerType).secret"
              type="password"
              autocomplete="off"
              class="w-full"
              :placeholder="p.hasSecret ? 'Replace existing secret…' : 'Paste secret…'"
            />
          </UFormField>
          <UFormField
            v-if="showClaudeWorkspaceField(p)"
            label="Anthropic workspace ID"
            hint="Leave empty for workspace-scoped keys. Fill wrkspc_… if Anthropic asks for anthropic-workspace-id."
          >
            <UInput
              v-model="draftFor(p.providerType).anthropicWorkspaceId"
              autocomplete="off"
              class="w-full"
              placeholder="wrkspc_…"
            />
          </UFormField>
          <div class="flex flex-wrap gap-2">
            <UButton
              size="sm"
              :loading="busy === `connect-${p.providerType}`"
              @click="connect(p)"
            >
              {{ p.hasSecret ? 'Replace & connect' : 'Connect' }}
            </UButton>
            <UButton
              size="sm"
              variant="ghost"
              @click="draftFor(p.providerType).showConnect = false"
            >
              Cancel
            </UButton>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <UButton size="sm" :loading="busy === `save-${p.providerType}`" @click="save(p)">
            Save
          </UButton>
          <UButton
            size="sm"
            variant="soft"
            :loading="busy === p.providerType"
            @click="test(p.providerType)"
          >
            Test provider
          </UButton>
          <UButton
            v-if="!draftFor(p.providerType).showConnect"
            size="sm"
            variant="soft"
            @click="draftFor(p.providerType).showConnect = true"
          >
            {{ p.hasSecret ? 'Update secret' : 'Connect' }}
          </UButton>
          <UButton
            v-if="p.hasStoredSecret"
            size="sm"
            color="error"
            variant="ghost"
            :loading="busy === `disconnect-${p.providerType}`"
            @click="disconnect(p)"
          >
            Disconnect
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
