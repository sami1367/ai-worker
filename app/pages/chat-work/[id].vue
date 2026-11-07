<script setup lang="ts">
import { ACTIVE_WORK_STATUSES, type ChatWorkRunView } from '#shared/chat-work'
const { api } = useApi()
const route = useRoute()
const id = String(route.params.id)
const run = ref<ChatWorkRunView | null>(null)
const log = ref('')
const error = ref('')
const retrying = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
async function refresh() {
  try {
    const result = await api<{ run: ChatWorkRunView, log: string }>(`/api/v1/chat-work/runs/${id}`)
    run.value = result.run; log.value = result.log; error.value = ''
  } catch { error.value = 'Could not load the work run. Please retry.' }
}
async function retry() {
  retrying.value = true
  try { await api(`/api/v1/chat-work/runs/${id}/retry-publish`, { method: 'POST' }); await refresh() } catch { error.value = 'Could not retry publishing. Another run may be active for this chat.' } finally { retrying.value = false }
}
onMounted(() => { void refresh() })
onMounted(() => { timer = setInterval(() => { if (!document.hidden && run.value && ACTIVE_WORK_STATUSES.includes(run.value.status)) void refresh() }, 5000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="space-y-5 aw-fade-in">
    <UButton to="/chat-work" variant="ghost" color="neutral" icon="i-lucide-arrow-left">All chat work</UButton>
    <UAlert v-if="error" color="error" :title="error" :actions="[{ label: 'Retry', onClick: refresh }]" />
    <template v-if="run">
      <div class="flex flex-wrap items-start justify-between gap-3"><div><h1 class="font-display text-2xl">{{ run.title }}</h1><p class="mt-2 text-sm opacity-60">{{ run.status }} · {{ run.provider }} · Plan {{ run.planRevision }}</p></div><div class="flex gap-2"><UButton :to="run.chatUrl" variant="soft" icon="i-lucide-message-circle">Open chat</UButton><UButton v-if="run.canRetryPublish" :loading="retrying" icon="i-lucide-refresh-cw" @click="retry">Retry publishing</UButton></div></div>
      <UAlert v-if="run.status === 'queued'" color="info" title="Waiting for a background worker" description="The worker must be running to pick up this approved plan." />
      <UAlert v-if="run.errorSummary" color="error" :title="run.errorSummary" />
      <div class="grid gap-3 md:grid-cols-2">
        <article v-for="repo in run.repositories.filter(repo => run!.tasks.some(task => task.repositoryIds.includes(repo.id)))" :key="repo.id" class="aw-panel space-y-2 rounded-xl p-4">
          <h2 class="font-medium">{{ repo.name }}</h2><p class="text-sm opacity-65">{{ run.results.find(result => result.repositoryId === repo.id)?.status || run.status }}</p>
          <p v-if="run.results.find(result => result.repositoryId === repo.id)?.error" class="break-words text-sm text-red-500">{{ run.results.find(result => result.repositoryId === repo.id)?.error }}</p>
          <UButton v-if="run.results.find(result => result.repositoryId === repo.id)?.url" :to="run.results.find(result => result.repositoryId === repo.id)?.url" target="_blank" rel="noopener noreferrer" variant="soft" icon="i-lucide-git-pull-request">Open pull / merge request</UButton>
        </article>
      </div>
      <details class="aw-panel rounded-xl p-4"><summary class="cursor-pointer font-medium">Approved tasks ({{ run.tasks.length }})</summary><article v-for="task in run.tasks" :key="task.id" class="mt-4 space-y-2"><h3 class="font-medium">{{ task.title }}</h3><ChatMarkdown :content="task.body" class="text-sm" /></article></details>
      <details class="aw-panel rounded-xl p-4" open><summary class="cursor-pointer font-medium">Agent output & test results</summary><pre class="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words text-xs" dir="ltr">{{ log || 'The agent has not written output yet.' }}</pre></details>
    </template>
  </div>
</template>
