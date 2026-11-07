<script setup lang="ts">
import type { MicroserviceGroupInput, MicroserviceProject } from '#shared/microservices'
type Session = { id: string, title: string, messages: Array<{ id: string, role: string, content: string }> }
type Summary = { id: string, title: string, updatedAt: string }
type Detail = {
  group: MicroserviceGroupInput & { id: string, projects: MicroserviceProject[], workspaceStatus: string, codegraphStatus: string, lastError: string | null, preparedAt: string | null }
  workspacePath: string
  projects: Array<MicroserviceProject & { name: string, workspaceStatus: string }>
}
const { api } = useApi()
const { t } = useI18n()
const route = useRoute()
const groupId = String(route.params.groupId)
const base = `/api/v1/microservices/groups/${groupId}`
const detail = ref<Detail | null>(null)
const session = ref<Session | null>(null)
const chats = ref<Summary[]>([])
const draft = ref('')
const busy = ref('')
const error = ref('')
const editing = ref(false)
const showProjects = ref(true)
const chatEl = ref<HTMLElement | null>(null)
const workActionsEl = ref<HTMLElement | null>(null)
const indexing = computed(() => ['indexing', 'queued'].includes(detail.value?.group.codegraphStatus || ''))
const preparing = computed(() => ['queued', 'waiting', 'preparing'].includes(detail.value?.group.workspaceStatus || ''))
let poll: ReturnType<typeof setInterval> | null = null
async function refreshGroup() {
  detail.value = await api<Detail>(base)
}
async function history() {
  chats.value = (await api<{ items: Summary[] }>(`${base}/sessions`)).items
}
async function scroll() {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
}
async function run(action: () => Promise<void>, state = 'load') {
  if (busy.value) return
  busy.value = state
  error.value = ''
  try { await action() } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    error.value = err.data?.message || err.message || 'Something went wrong. Please try again.'
  } finally { busy.value = '' }
}
async function openChat(id: string) {
  session.value = (await api<{ session: Session }>(`${base}/sessions/${id}`)).session
  draft.value = ''
  await navigateTo({ query: { chat: id } }, { replace: true })
  await scroll()
}
async function newChat() {
  const result = await api<{ session: Session }>(`${base}/sessions`, { method: 'POST' })
  session.value = result.session
  draft.value = ''
  await Promise.all([history(), navigateTo({ query: { chat: result.session.id } }, { replace: true })])
  await scroll()
}
async function deleteConversation(chat: Summary) {
  if (busy.value || !confirm(t('chat.deleteConversationConfirm', { title: chat.title }))) return
  await run(async () => {
    await api(`${base}/sessions/${chat.id}`, { method: 'DELETE' })
    chats.value = chats.value.filter(item => item.id !== chat.id)
    if (session.value?.id === chat.id) {
      session.value = null
      draft.value = ''
      if (chats.value[0]) await openChat(chats.value[0].id)
      else await navigateTo({ query: {} }, { replace: true })
    }
  }, 'delete')
}

async function prepare() {
  await api(`${base}/prepare`, { method: 'POST' })
  await refreshGroup()
}
async function retryCodegraph() {
  await api(`${base}/codegraph/retry`, { method: 'POST' })
  await refreshGroup()
}
async function save(value: MicroserviceGroupInput) {
  await run(async () => {
    await api(base, { method: 'PATCH', body: value })
    editing.value = false
    await refreshGroup()
  }, 'save')
}
async function send() {
  const content = draft.value.trim()
  if (!content || !session.value || detail.value?.group.workspaceStatus !== 'ready') return
  await run(async () => {
    const result = await api<{ session: Session }>(`${base}/sessions/${session.value!.id}/messages`, { method: 'POST', body: { content } })
    session.value = result.session
    draft.value = ''
    await history()
    await scroll()
  }, 'send')
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send() }
}
onMounted(() => { void run(async () => {
  await Promise.all([refreshGroup(), history()])
  const requested = typeof route.query.chat === 'string' ? route.query.chat : ''
  if (requested) await openChat(requested)
  else if (chats.value[0]) await openChat(chats.value[0].id)
  else await newChat()
}) })
onMounted(() => {
  poll = setInterval(() => {
    if ((preparing.value || indexing.value) && !busy.value) void refreshGroup().catch(() => { error.value = 'Could not refresh workspace status. Reload the page to retry.' })
  }, 5000)
})
onBeforeUnmount(() => { if (poll) clearInterval(poll) })
</script>

<template>
  <div class="space-y-4 aw-fade-in">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <UButton to="/microservices" variant="ghost" color="neutral" icon="i-lucide-arrow-left">All groups</UButton>
        <h1 class="font-display text-2xl md:text-3xl">{{ detail?.group.name || 'Group chat' }}</h1>
        <p v-if="detail?.group.description" class="mt-1 max-w-2xl text-sm opacity-70">{{ detail.group.description }}</p>
        <div v-if="detail" class="mt-2 flex flex-wrap gap-2">
          <UBadge :color="detail.group.workspaceStatus === 'ready' ? 'success' : detail.group.workspaceStatus === 'failed' ? 'error' : 'warning'" variant="subtle">Workspace: {{ detail.group.workspaceStatus }}</UBadge>
          <UBadge color="neutral" variant="subtle">CodeGraph: {{ detail.group.codegraphStatus }}</UBadge>
          <UBadge color="neutral" variant="subtle">{{ detail.projects.length }} projects</UBadge>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ConversationCopyButton :key="session?.id" :messages="session?.messages || []" :disabled="Boolean(busy)" />
        <UButton variant="soft" color="neutral" icon="i-lucide-settings-2" :disabled="Boolean(busy) || preparing || indexing" @click="editing = !editing">Edit group</UButton>
        <UButton variant="soft" icon="i-lucide-refresh-cw" :disabled="Boolean(busy) || preparing || indexing || !detail" @click="run(prepare, 'prepare')">{{ detail?.group.workspaceStatus === 'failed' ? 'Retry preparation' : 'Sync workspace' }}</UButton>
        <UButton v-if="detail?.group.codegraphEnabled && detail.group.workspaceStatus === 'ready' && ['unavailable', 'failed'].includes(detail.group.codegraphStatus)" variant="soft" icon="i-lucide-network" :disabled="Boolean(busy) || indexing" @click="run(retryCodegraph, 'codegraph')">Retry CodeGraph</UButton>
        <UButton icon="i-lucide-plus" :disabled="Boolean(busy) || !detail" @click="run(newChat, 'new')">New chat</UButton>
      </div>
    </div>
    <UAlert v-if="error" color="error" :title="error" />
    <UAlert v-if="detail?.group.lastError" :color="detail.group.workspaceStatus === 'failed' || detail.group.codegraphStatus === 'unavailable' ? 'error' : 'warning'" :title="detail.group.lastError" />
    <UAlert v-if="indexing && !preparing" color="info" title="Projects are ready — CodeGraph is indexing" description="You can chat now using repository snapshots. CodeGraph context will be added when indexing finishes." />
    <UAlert v-if="preparing" color="info" title="Preparing the group workspace" description="Preparing project checkouts in the background. You can read previous chats while preparation runs. This page updates automatically." />
    <div v-if="editing && detail" class="aw-panel space-y-4 rounded-xl p-5">
      <p class="text-sm opacity-70">Changes apply to future replies. Your existing conversations stay saved.</p>
      <MicroserviceGroupForm :initial="detail.group" :busy="busy === 'save'" @save="save" @cancel="editing = false" />
    </div>
    <div v-if="detail" class="aw-panel rounded-xl p-4">
      <button type="button" class="flex w-full items-center justify-between text-sm font-medium" :aria-expanded="showProjects" aria-controls="group-projects" @click="showProjects = !showProjects"><span>Projects & workspace</span><UIcon :name="showProjects ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
      <div v-if="showProjects" id="group-projects" class="mt-3 space-y-3">
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="project in detail.projects" :key="project.repositoryId" class="rounded-lg border border-[var(--aw-line)] p-3">
            <div class="flex items-center justify-between gap-2"><span class="text-sm font-medium">{{ project.name }}</span><span class="text-xs opacity-50">{{ project.workspaceStatus }}</span></div>
            <code class="text-xs opacity-60">{{ project.directory }}/</code>
            <div class="mt-2 flex flex-wrap gap-1"><UBadge v-for="label in project.labels" :key="label" color="neutral" variant="subtle" size="sm">{{ label }}</UBadge></div>
            <p v-if="project.description" class="mt-2 text-xs opacity-70">{{ project.description }}</p>
          </div>
        </div>
        <p class="break-all text-xs opacity-60">Group directory: <code>{{ detail.workspacePath }}</code></p>
        <p v-if="detail.group.preparedAt" class="text-xs opacity-60">Snapshot prepared {{ new Date(detail.group.preparedAt).toLocaleString() }}. Sync the workspace to fetch the latest configured branches and rebuild group context.</p>
      </div>
    </div>
    <div class="flex h-[min(70vh,55rem)] min-h-[30rem] flex-col gap-4 md:flex-row">
      <aside class="aw-panel max-h-36 overflow-y-auto rounded-xl p-3 md:max-h-none md:w-56 md:shrink-0" aria-label="Group chat history">
        <h2 class="mb-3 text-sm font-medium">Your conversations</h2>
        <ConversationHistoryItem v-for="chat in chats" :key="chat.id" :title="chat.title" :updated-at="chat.updatedAt" :active="session?.id === chat.id" :disabled="Boolean(busy)" @open="run(() => openChat(chat.id))" @delete="deleteConversation(chat)" />
        <p v-if="!chats.length && !busy" class="px-2 text-xs opacity-60">{{ t('chat.noConversations') }}</p>
      </aside>
      <div class="aw-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
        <ChatWorkPanel v-if="session" :key="session.id" scope="microservice" :session-id="session.id" :message-count="session.messages.length" :disabled="Boolean(busy)" :ready="detail?.group.workspaceStatus === 'ready'" embedded :actions-target="workActionsEl" @focus-actions="scroll" />
        <div ref="chatEl" role="log" aria-live="polite" aria-label="Group conversation" class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
          <p v-if="!session && !busy" class="py-10 text-center text-sm opacity-60">{{ t('chat.noConversations') }}</p>
          <div v-if="session && !session.messages.length" class="py-10 text-center text-sm opacity-60"><p>Ask about the whole system.</p><p class="mt-2">For example: “How does a request move between these services?” or “Which projects handle authentication?”</p></div>
          <div v-for="msg in session?.messages || []" :key="msg.id" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
            <div class="min-w-0 max-w-[92%] rounded-2xl bg-black/5 px-4 py-3 text-sm dark:bg-white/5"><div class="mb-2 flex items-center justify-between gap-4"><p class="text-xs opacity-60">{{ msg.role === 'user' ? 'You' : 'Assistant' }}</p><MessageCopyButton :content="msg.content" /></div><ChatMarkdown :content="msg.content" /></div>
          </div>
          <p v-if="busy === 'send'" class="text-sm opacity-60" role="status">Reading group context and answering…</p>
          <div ref="workActionsEl" />
        </div>
        <form class="flex items-end gap-2 border-t border-[var(--aw-line)] p-4" @submit.prevent="send">
          <UTextarea v-model="draft" aria-label="Message about this group" :placeholder="detail?.group.workspaceStatus === 'ready' ? 'Ask about your services…' : 'Waiting for the workspace to be ready…'" class="w-full" :rows="3" :maxlength="20000" :disabled="Boolean(busy) || !session || detail?.group.workspaceStatus !== 'ready'" @keydown="keydown" />
          <UButton type="submit" icon="i-lucide-send" :loading="busy === 'send'" :disabled="Boolean(busy) || !draft.trim() || !session || detail?.group.workspaceStatus !== 'ready'">Send</UButton>
        </form>
      </div>
    </div>
  </div>
</template>
