<script setup lang="ts">
type Session = { id: string, repositoryId: string, title: string, messages: Array<{ id: string, role: string, content: string }> }
type ChatSummary = { id: string, title: string, updatedAt: string }
const { api } = useApi()
const route = useRoute()
const repositoryId = String(route.params.repoId)
const session = ref<Session | null>(null)
const chats = ref<ChatSummary[]>([])
const name = ref('Project chat')
const workspaceStatus = ref('')
const draft = ref('')
const busy = ref(false)
const error = ref('')
const contextAvailable = ref<boolean | null>(null)
const chatEl = ref<HTMLElement | null>(null)

function errorText(e: unknown) {
  const err = e as { data?: { message?: string }, message?: string }
  return err.data?.message || err.message || 'Could not load chat. Please try again.'
}
async function refreshHistory() {
  const result = await api<{ items: ChatSummary[] }>(`/api/v1/project-chat/sessions?repositoryId=${repositoryId}`)
  chats.value = result.items
}
async function scroll() {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
}
async function open(id: string) {
  const result = await api<{ session: Session, repository: { name: string, workspaceStatus: string }, contextAvailable: boolean }>(`/api/v1/project-chat/sessions/${id}`)
  if (result.session.repositoryId !== repositoryId) throw new Error('Chat belongs to another project')
  session.value = result.session
  name.value = result.repository.name
  workspaceStatus.value = result.repository.workspaceStatus
  contextAvailable.value = result.contextAvailable
  draft.value = ''
  await navigateTo({ query: { chat: id } }, { replace: true })
  await scroll()
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (e) { error.value = errorText(e) } finally { busy.value = false }
}
async function newChat() {
  const result = await api<{ session: Session }>('/api/v1/project-chat/sessions', { method: 'POST', body: { repositoryId } })
  await refreshHistory()
  await open(result.session.id)
}
async function send() {
  const content = draft.value.trim()
  if (!content || !session.value) return
  await run(async () => {
    const result = await api<{ session: Session, contextAvailable: boolean }>(`/api/v1/project-chat/sessions/${session.value!.id}/messages`, {
      method: 'POST', body: { content },
    })
    session.value = result.session
    contextAvailable.value = result.contextAvailable
    draft.value = ''
    await refreshHistory()
    await scroll()
  })
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}
await run(async () => {
  await refreshHistory()
  const requested = typeof route.query.chat === 'string' ? route.query.chat : ''
  if (requested) await open(requested)
  else if (chats.value[0]) await open(chats.value[0].id)
  else await newChat()
})
</script>

<template>
  <div class="flex h-[calc(100vh-8rem)] min-h-[30rem] flex-col gap-4 aw-fade-in">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <UButton to="/project-chat" variant="ghost" color="neutral" icon="i-lucide-arrow-left">Projects</UButton>
        <h1 class="font-display text-2xl">{{ name }}</h1>
        <p class="mt-1 text-sm opacity-70">Ask about the code, architecture, or ideas for this project.</p>
        <p v-if="workspaceStatus && workspaceStatus !== 'ready'" class="mt-1 text-xs opacity-70">Workspace: {{ workspaceStatus }}. Repository context will load when the workspace is ready.</p>
        <p v-if="contextAvailable === false" class="mt-1 text-xs text-amber-600">Repository context is unavailable. Answers may need more detail from you.</p>
      </div>
      <UButton icon="i-lucide-plus" :disabled="busy" @click="run(newChat)">New chat</UButton>
    </div>
    <UAlert v-if="error" color="error" :title="error" />
    <div class="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <aside class="aw-panel max-h-40 overflow-y-auto rounded-xl p-3 md:max-h-none md:w-64 md:shrink-0" aria-label="Chat history">
        <h2 class="mb-3 text-sm font-medium">Your conversations</h2>
        <button v-for="chat in chats" :key="chat.id" class="mb-1 block w-full rounded-lg p-2 text-start text-sm hover:bg-black/5 dark:hover:bg-white/5" :class="session?.id === chat.id ? 'bg-black/5 dark:bg-white/10' : ''" :disabled="busy" @click="run(() => open(chat.id))">
          <span class="block truncate">{{ chat.title }}</span>
          <time class="text-xs opacity-50">{{ new Date(chat.updatedAt).toLocaleDateString() }}</time>
        </button>
      </aside>
      <div class="aw-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
        <div ref="chatEl" role="log" aria-label="Conversation" aria-live="polite" class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
          <p v-if="session && !session.messages.length" class="py-12 text-center text-sm opacity-60">Start a conversation about {{ name }}. Your chat is saved automatically.</p>
          <div v-for="msg in session?.messages || []" :key="msg.id" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
            <div class="min-w-0 max-w-[92%] rounded-2xl bg-black/5 px-4 py-3 text-sm dark:bg-white/5">
              <p class="mb-1 text-xs opacity-60">{{ msg.role === 'user' ? 'You' : 'Assistant' }}</p>
              <ChatMarkdown :content="msg.content" />
            </div>
          </div>
          <p v-if="busy" class="text-sm opacity-60">Working…</p>
        </div>
        <form class="flex items-end gap-2 border-t border-[var(--aw-line)] p-4" @submit.prevent="send">
          <UTextarea v-model="draft" aria-label="Message" placeholder="Ask a question about this project…" class="w-full" :rows="3" :maxlength="20000" :disabled="busy || !session" @keydown="keydown" />
          <UButton type="submit" icon="i-lucide-send" :loading="busy" :disabled="busy || !draft.trim() || !session">Send</UButton>
        </form>
      </div>
    </div>
  </div>
</template>
