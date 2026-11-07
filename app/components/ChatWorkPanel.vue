<script setup lang="ts">
import { ACTIVE_WORK_STATUSES, type ChatScope, type ChatWorkView } from '#shared/chat-work'
const props = defineProps<{ scope: ChatScope, sessionId: string, messageCount: number, disabled?: boolean, ready?: boolean }>()
const { api } = useApi()
const state = ref<ChatWorkView | null>(null)
const busy = ref('')
const error = ref('')
const base = computed(() => `/api/v1/chat-work/${props.scope}/${props.sessionId}`)
const active = computed(() => state.value?.runs.find(run => ACTIVE_WORK_STATUSES.includes(run.status)))
const approved = computed(() => state.value?.runs.some(run => run.planRevision === state.value?.revision))
let timer: ReturnType<typeof setInterval> | null = null
async function refresh() { state.value = await api<ChatWorkView>(base.value) }
async function run(action: () => Promise<void>, name: string) {
  if (busy.value || props.disabled) return
  busy.value = name
  error.value = ''
  try { await action() } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    error.value = err.data?.message || err.message || 'Could not update work mode. Please try again.'
  } finally { busy.value = '' }
}
async function changeMode(mode: 'chat' | 'work') {
  await run(async () => { state.value = await api<ChatWorkView>(base.value, { method: 'PATCH', body: { mode } }) }, 'mode')
}
async function generate() {
  await run(async () => { state.value = await api<ChatWorkView>(`${base.value}/generate`, { method: 'POST' }) }, 'generate')
}
async function approve() {
  if (!state.value) return
  await run(async () => {
    await api(`${base.value}/approve`, { method: 'POST', body: { revision: state.value!.revision } })
    await refresh()
  }, 'approve')
}
watch(() => [props.messageCount, props.disabled, props.ready], () => { if (!busy.value && !props.disabled) void run(refresh, 'load') })
await run(refresh, 'load')
onMounted(() => {
  timer = setInterval(() => { if (active.value && !busy.value && !props.disabled) void refresh().catch(() => {}) }, 5000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="aw-panel space-y-3 rounded-xl p-4" aria-label="Chat and work mode">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="flex gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/5" role="group" aria-label="Conversation mode">
          <UButton size="sm" :variant="state?.mode !== 'work' ? 'solid' : 'ghost'" :aria-pressed="state?.mode !== 'work'" :disabled="Boolean(busy) || disabled || !state" icon="i-lucide-message-circle" @click="changeMode('chat')">Chat</UButton>
          <UButton size="sm" :variant="state?.mode === 'work' ? 'solid' : 'ghost'" :aria-pressed="state?.mode === 'work'" :disabled="Boolean(busy) || disabled || !state" icon="i-lucide-hammer" @click="changeMode('work')">Work</UButton>
        </div>
        <p class="hidden text-xs opacity-60 lg:block">{{ state?.mode === 'work' ? 'Plan, review, then approve background implementation.' : 'Discuss your project. No implementation runs until you approve a plan.' }}</p>
      </div>
      <UButton to="/chat-work" variant="ghost" color="neutral" size="sm" icon="i-lucide-list-checks">Chat work</UButton>
    </div>
    <UAlert v-if="error" color="error" :title="error" :actions="[{ label: 'Retry', onClick: () => run(refresh, 'load') }]" />
    <div v-if="state?.mode === 'work'" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <UButton variant="soft" icon="i-lucide-sparkles" :loading="busy === 'generate'" :disabled="Boolean(busy) || disabled || !ready || Boolean(active)" @click="generate">{{ state.tasks.length ? 'Regenerate tasks' : 'Generate tasks' }}</UButton>
        <UButton icon="i-lucide-play" :loading="busy === 'approve'" :disabled="Boolean(busy) || disabled || !ready || !state.tasks.length || state.stale || Boolean(active) || approved" @click="approve">Approve & start work</UButton>
        <span v-if="state.generatedAt" class="text-xs opacity-50">Plan {{ state.revision }}</span>
      </div>
      <p class="text-xs opacity-65">Tasks stay inside this chat. Approval queues background work and one PR/MR per changed repository. No GitHub or GitLab issues are created.</p>
      <p v-if="!ready" class="text-xs opacity-70">Prepare the workspace before generating or approving tasks.</p>
      <UAlert v-if="state.stale" color="warning" title="The conversation or project configuration changed. Regenerate tasks before approving." />
      <div v-if="state.tasks.length" class="max-h-[45vh] space-y-3 overflow-y-auto border-t border-[var(--aw-line)] pt-3" aria-label="Generated tasks">
        <article v-for="(task, index) in state.tasks" :key="task.id" class="rounded-lg border border-[var(--aw-line)] p-3">
          <h3 class="text-sm font-semibold">{{ index + 1 }}. {{ task.title }}</h3>
          <div class="my-2 flex flex-wrap gap-1"><UBadge v-for="repositoryId in task.repositoryIds" :key="repositoryId" variant="subtle" color="neutral" size="sm">{{ state.repositories.find(repo => repo.id === repositoryId)?.name || repositoryId }}</UBadge></div>
          <ChatMarkdown :content="task.body" class="text-sm" />
        </article>
      </div>
    </div>
    <div v-if="active" class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/5 p-3 text-sm dark:bg-white/5" role="status"><span>Background work: {{ active.status }} · {{ active.title }}</span><UButton :to="`/chat-work/${active.id}`" size="sm" variant="soft">View progress</UButton></div>
    <div v-else-if="state?.runs[0]" class="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--aw-line)] pt-3 text-sm"><span>Latest work: {{ state.runs[0].status }}</span><UButton :to="`/chat-work/${state.runs[0].id}`" size="sm" variant="ghost">View results</UButton></div>
  </section>
</template>
