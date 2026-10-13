<script setup lang="ts">
const { api } = useApi()
const { data, pending, refresh } = await useAsyncData('providers', () => api<any>('/api/v1/providers'))
const busy = ref('')
const message = ref('')
const messageError = ref(false)

type Draft = {
  secret: string
  credentialType: 'anthropic_api_key' | 'claude_oauth_token'
  showConnect: boolean
}

const drafts = reactive<Record<string, Draft>>({})

function draftFor(providerType: string): Draft {
  if (!drafts[providerType]) {
    drafts[providerType] = {
      secret: '',
      credentialType: 'anthropic_api_key',
      showConnect: false,
    }
  }
  return drafts[providerType]
}

watchEffect(() => {
  for (const p of data.value?.items || []) {
    const d = draftFor(p.providerType)
    const existing = p.config?.credentialType
    if (existing === 'claude_oauth_token' || existing === 'anthropic_api_key') {
      d.credentialType = existing
    }
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

async function save(p: any) {
  busy.value = `save-${p.providerType}`
  message.value = ''
  messageError.value = false
  try {
    const d = draftFor(p.providerType)
    const config = {
      ...(p.config || {}),
      ...(p.providerType === 'claude' ? { credentialType: d.credentialType } : {}),
    }
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: {
        isEnabled: p.isEnabled,
        isDefault: p.isDefault,
        config,
      },
    })
    message.value = `Saved ${p.displayName}`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Save failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
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
      ...(p.providerType === 'claude' ? { credentialType: d.credentialType } : { credentialType: 'cursor_api_key' }),
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
  } catch (e: any) {
    message.value = e?.data?.message || 'Disconnect failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function secretHint(p: any): string {
  if (p.providerType === 'cursor') {
    return 'Cursor API key (CURSOR_API_KEY). Create one in Cursor dashboard settings.'
  }
  const d = draftFor(p.providerType)
  return d.credentialType === 'claude_oauth_token'
    ? 'Claude Code OAuth token (CLAUDE_CODE_OAUTH_TOKEN)'
    : 'Anthropic API key (ANTHROPIC_API_KEY) from console.anthropic.com'
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">AI providers</h1>
      <p class="mt-1 text-sm opacity-70">
        Cursor and Claude CLIs are installed in the Docker image. Set
        <code class="text-xs">CURSOR_API_KEY</code> /
        <code class="text-xs">ANTHROPIC_API_KEY</code> /
        <code class="text-xs">CLAUDE_CODE_OAUTH_TOKEN</code>
        in the compose <code class="text-xs">.env</code>, or paste secrets here (encrypted at rest, never shown again).
      </p>
    </div>
    <UAlert
      v-if="message"
      :title="message"
      :color="messageError ? 'error' : 'success'"
      variant="subtle"
    />
    <div v-if="pending && !data" class="grid gap-4 md:grid-cols-2">
      <div v-for="i in 2" :key="i" class="aw-panel h-48 animate-pulse rounded-xl" />
    </div>
    <div v-else class="grid gap-4 md:grid-cols-2">
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
        <UCheckbox v-model="p.isEnabled" label="Enabled" />
        <UCheckbox v-model="p.isDefault" label="Default provider" />

        <div v-if="draftFor(p.providerType).showConnect" class="space-y-3 border-t border-default/40 pt-3">
          <UFormField
            v-if="p.providerType === 'claude'"
            label="Credential type"
          >
            <USelect
              v-model="draftFor(p.providerType).credentialType"
              :items="[
                { label: 'Anthropic API key', value: 'anthropic_api_key' },
                { label: 'Claude OAuth token', value: 'claude_oauth_token' },
              ]"
            />
          </UFormField>
          <UFormField :label="p.providerType === 'cursor' ? 'Cursor API key' : 'Secret'" :hint="secretHint(p)">
            <UInput
              v-model="draftFor(p.providerType).secret"
              type="password"
              autocomplete="off"
              class="w-full"
              :placeholder="p.hasSecret ? 'Replace existing secret…' : 'Paste secret…'"
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
