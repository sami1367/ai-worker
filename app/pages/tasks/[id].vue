<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const id = computed(() => String(route.params.id))

const { data, pending } = await useAsyncData(
  () => `run-${id.value}`,
  () => api<any>(`/api/v1/runs/${id.value}`),
  { watch: [id] },
)

const logLines = ref<string[]>([])
const logStatus = ref('connecting')

onMounted(async () => {
  const tail = await api<any>(`/api/v1/runs/${id.value}/logs`).catch(() => null)
  if (tail?.content) logLines.value = tail.content.split('\n')
  if (tail && !tail.available) logStatus.value = tail.reason || 'unavailable'
  else logStatus.value = 'live'

  const es = new EventSource(`/api/v1/runs/${id.value}/log-stream`, { withCredentials: true })
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'line') logLines.value.push(msg.line)
      if (msg.type === 'done') {
        logStatus.value = `finished (${msg.status})`
        es.close()
      }
      if (msg.type === 'error') {
        logStatus.value = msg.message || 'stream error'
        es.close()
      }
    } catch {
      // ignore malformed
    }
  }
  es.onerror = () => {
    if (logStatus.value === 'live' || logStatus.value === 'connecting') {
      logStatus.value = 'disconnected (will keep showing loaded tail)'
    }
    es.close()
  }
  onBeforeUnmount(() => es.close())
})
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div v-if="pending && !data" class="aw-panel h-40 animate-pulse rounded-xl" />
    <template v-else-if="data">
      <div>
        <p class="text-sm opacity-60"><NuxtLink to="/tasks" class="hover:underline">Tasks</NuxtLink></p>
        <h1 class="font-display text-3xl tracking-tight">{{ data.title || `Task ${data.externalId}` }}</h1>
        <p class="mt-1 text-sm opacity-70">{{ data.taskType }} · {{ data.status }} · {{ data.provider || 'provider n/a' }}</p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="aw-panel rounded-xl p-4 text-sm space-y-1">
          <p><span class="opacity-60">Repository:</span> {{ data.repositoryName || '—' }}</p>
          <p><span class="opacity-60">External ID:</span> {{ data.externalId }}</p>
          <p>
            <span class="opacity-60">External URL:</span>
            <a v-if="data.externalUrl" :href="data.externalUrl" target="_blank" class="hover:underline">{{ data.externalUrl }}</a>
            <span v-else>—</span>
          </p>
          <p><span class="opacity-60">Started:</span> {{ data.startedAt || '—' }}</p>
          <p><span class="opacity-60">Finished:</span> {{ data.finishedAt || '—' }}</p>
          <p><span class="opacity-60">Exit code:</span> {{ data.exitCode ?? '—' }}</p>
          <p><span class="opacity-60">Correlation:</span> {{ data.correlationId }}</p>
          <p><span class="opacity-60">Error:</span> {{ data.errorSummary || '—' }}</p>
        </div>
        <div class="aw-panel rounded-xl p-4 text-sm">
          <p class="opacity-60">Result metadata</p>
          <pre class="mt-2 overflow-auto text-xs">{{ JSON.stringify(data.resultMetadata || {}, null, 2) }}</pre>
        </div>
      </div>

      <div class="aw-panel rounded-xl p-4">
        <div class="mb-2 flex items-center justify-between">
          <h2 class="font-display text-xl">Logs</h2>
          <span class="text-xs opacity-60">{{ logStatus }}</span>
        </div>
        <pre class="max-h-[28rem] overflow-auto rounded-lg bg-black/90 p-4 text-xs text-green-100 whitespace-pre-wrap break-all">{{ logLines.join('\n') || 'No log content available.' }}</pre>
      </div>
    </template>
  </div>
</template>
