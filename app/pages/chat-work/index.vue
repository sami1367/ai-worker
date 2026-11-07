<script setup lang="ts">
import { ACTIVE_WORK_STATUSES, type ChatWorkRunView } from '#shared/chat-work'
const { api } = useApi()
const items = ref<ChatWorkRunView[]>([])
const error = ref('')
const activeOnly = ref(false)
const visible = computed(() => items.value.filter(run => !activeOnly.value || ACTIVE_WORK_STATUSES.includes(run.status)))
let timer: ReturnType<typeof setInterval> | null = null
async function refresh() {
  try { items.value = (await api<{ items: ChatWorkRunView[] }>('/api/v1/chat-work/runs')).items; error.value = '' } catch { error.value = 'Could not load chat work. Please retry.' }
}
await refresh()
onMounted(() => { timer = setInterval(() => { void refresh() }, 5000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="space-y-5 aw-fade-in">
    <div><h1 class="font-display text-3xl">Chat work</h1><p class="mt-2 text-sm opacity-70">Approved work from your project and microservice chats. Runs continue in the background after you leave the chat.</p></div>
    <UAlert v-if="error" color="error" :title="error" :actions="[{ label: 'Retry', onClick: refresh }]" />
    <label class="flex items-center gap-2 text-sm"><input v-model="activeOnly" type="checkbox">Show ongoing work only <UBadge variant="subtle">{{ items.filter(run => ACTIVE_WORK_STATUSES.includes(run.status)).length }}</UBadge></label>
    <div v-if="!visible.length && !error" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">{{ activeOnly ? 'No ongoing chat work.' : 'No chat work yet. Open a project or microservice chat, switch to Work mode, generate tasks, and approve your plan.' }}</div>
    <article v-for="run in visible" :key="run.id" class="aw-panel space-y-3 rounded-xl p-4">
      <div class="flex flex-wrap items-center justify-between gap-2"><NuxtLink :to="`/chat-work/${run.id}`" class="font-medium hover:underline">{{ run.title }}</NuxtLink><UBadge :color="run.status === 'succeeded' ? 'success' : ['failed', 'partial', 'interrupted'].includes(run.status) ? 'error' : 'neutral'" variant="subtle">{{ run.status }}</UBadge></div>
      <p class="text-xs opacity-60">{{ run.tasks.length }} tasks · {{ run.repositories.filter(repo => run.tasks.some(task => task.repositoryIds.includes(repo.id))).map(repo => repo.name).join(', ') }}</p>
      <p v-if="run.errorSummary" class="text-sm text-red-500">{{ run.errorSummary }}</p>
      <div class="flex flex-wrap gap-2"><UButton :to="`/chat-work/${run.id}`" size="sm" variant="soft">Progress & results</UButton><UButton :to="run.chatUrl" size="sm" variant="ghost" color="neutral" icon="i-lucide-message-circle">Open chat</UButton><UButton v-for="result in run.results.filter(result => result.url)" :key="result.repositoryId" :to="result.url" target="_blank" rel="noopener noreferrer" size="sm" variant="ghost" icon="i-lucide-git-pull-request">{{ result.name }}</UButton></div>
    </article>
  </div>
</template>
