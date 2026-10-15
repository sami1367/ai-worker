<script setup lang="ts">
const { api } = useApi()
const { data, pending, refresh } = await useAsyncData('settings', () => api<any>('/api/v1/settings'))
const saving = ref(false)
const message = ref('')

async function save() {
  if (!data.value) return
  saving.value = true
  message.value = ''
  try {
    await api('/api/v1/settings', {
      method: 'PATCH',
      body: {
        pollIntervalSeconds: Number(data.value.pollIntervalSeconds),
        maxGlobalConcurrentTasks: Number(data.value.maxGlobalConcurrentTasks),
        defaultAiProvider: data.value.defaultAiProvider,
        defaultBlockOnOpenPr: data.value.defaultBlockOnOpenPr,
        logRetentionDays: Number(data.value.logRetentionDays),
        timezone: data.value.timezone,
        uiTheme: data.value.uiTheme,
      },
    })
    message.value = 'Saved. Worker picks up AI provider and poll interval on the next cycle (usually within a few seconds).'
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Save failed'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-6 aw-fade-in max-w-2xl">
    <div>
      <h1 class="font-display text-3xl tracking-tight">Settings</h1>
      <p class="mt-1 text-sm opacity-70">Server-side runtime configuration</p>
    </div>
    <div v-if="pending && !data" class="aw-panel h-64 animate-pulse rounded-xl" />
    <form v-else-if="data" class="aw-panel space-y-4 rounded-xl p-4" @submit.prevent="save">
      <UFormField label="Default AI provider">
        <USelect
          v-model="data.defaultAiProvider"
          :items="[
            { label: 'Cursor', value: 'cursor' },
            { label: 'Claude Code', value: 'claude' },
            { label: 'Codex', value: 'codex' },
            { label: 'Gemini', value: 'gemini' },
          ]"
        />
      </UFormField>
      <UFormField label="Polling interval (seconds)" hint="Applied on the next worker poll cycle (no container restart).">
        <UInput v-model.number="data.pollIntervalSeconds" type="number" min="15" max="3600" />
      </UFormField>
      <UFormField label="Max global concurrent tasks" hint="Informational soft limit for operators; per-repo lock remains authoritative.">
        <UInput v-model.number="data.maxGlobalConcurrentTasks" type="number" min="1" max="64" />
      </UFormField>
      <UCheckbox v-model="data.defaultBlockOnOpenPr" label="Default: block new issues while an AI-labeled PR/MR is open" />
      <UFormField label="Log retention (days)">
        <UInput v-model.number="data.logRetentionDays" type="number" min="1" max="365" />
      </UFormField>
      <UFormField label="Timezone">
        <UInput v-model="data.timezone" />
      </UFormField>
      <UFormField label="UI theme preference">
        <USelect v-model="data.uiTheme" :items="[{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]" />
      </UFormField>
      <p class="text-xs opacity-60">Config version: {{ data.configVersion }}</p>
      <UAlert v-if="message" :title="message" />
      <UButton type="submit" :loading="saving">Save settings</UButton>
    </form>
  </div>
</template>
