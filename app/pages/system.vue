<script setup lang="ts">
const { api } = useApi()
const { data, pending, refresh } = await useAsyncData('diagnostics', () => api<any>('/api/v1/system/diagnostics'))
const busy = ref('')
const message = ref('')

async function control(action: string) {
  if (!confirm(`Confirm worker ${action}? Active AI runs are not force-killed on graceful stop/restart.`)) return
  busy.value = action
  message.value = ''
  try {
    const res = await api<any>(`/api/v1/worker/${action}`, { method: 'POST' })
    message.value = `Requested ${action}: ${res.status}${res.deduplicated ? ' (deduplicated)' : ''}`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || `${action} failed`
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">System</h1>
        <p class="mt-1 text-sm opacity-70">Diagnostics and worker control</p>
      </div>
      <UButton variant="soft" icon="i-lucide-refresh-cw" :loading="pending" @click="refresh()">Refresh</UButton>
    </div>

    <UAlert v-if="message" :title="message" />

    <div v-if="pending && !data" class="aw-panel h-64 animate-pulse rounded-xl" />
    <template v-else-if="data">
      <div class="grid gap-4 md:grid-cols-2">
        <div class="aw-panel rounded-xl p-4 text-sm space-y-1">
          <h2 class="font-display text-xl">Application</h2>
          <p>Version: {{ data.application.version }}</p>
          <p>Env: {{ data.application.nodeEnv }}</p>
          <p>Database: {{ data.database.ok ? 'connected' : data.database.message }}</p>
          <p>Config version: {{ data.settings.configVersion }}</p>
        </div>
        <div class="aw-panel rounded-xl p-4 text-sm space-y-1">
          <h2 class="font-display text-xl">Worker</h2>
          <p>Status: {{ data.worker.status }}</p>
          <p>Heartbeat: {{ data.worker.lastHeartbeatAt || 'unavailable' }}</p>
          <p>Last successful poll: {{ data.worker.lastSuccessfulPollAt || 'unavailable' }}</p>
          <p>Loaded config: {{ data.worker.configVersionLoaded ?? 'n/a' }} / current {{ data.worker.configVersionCurrent }}</p>
          <p>Active tasks: {{ data.worker.activeTaskCount }}</p>
          <p>Stale heartbeat: {{ data.worker.heartbeatStale }}</p>
        </div>
      </div>

      <div class="aw-panel rounded-xl p-4 text-sm">
        <h2 class="font-display text-xl mb-2">Host tools</h2>
        <div class="flex flex-wrap gap-2">
          <UBadge v-for="(ok, name) in data.tools" :key="name" :color="ok ? 'success' : 'error'" variant="subtle">
            {{ name }}: {{ ok ? 'yes' : 'no' }}
          </UBadge>
        </div>
      </div>

      <div class="aw-panel rounded-xl p-4">
        <h2 class="font-display text-xl mb-3">Worker actions</h2>
        <div class="flex flex-wrap gap-2">
          <UButton :loading="busy==='reload'" @click="control('reload')">Reload config</UButton>
          <UButton :loading="busy==='start'" variant="soft" @click="control('start')">Start / resume</UButton>
          <UButton :loading="busy==='stop'" color="warning" variant="soft" @click="control('stop')">Graceful stop</UButton>
          <UButton :loading="busy==='restart'" color="warning" @click="control('restart')">Restart</UButton>
        </div>
        <p class="mt-3 text-xs opacity-60">
          Actions enqueue authenticated control requests. The worker container acknowledges them; the web process never runs arbitrary shell.
        </p>
      </div>
    </template>
  </div>
</template>
