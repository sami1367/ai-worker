<script setup lang="ts">
type DraftTask = { localId: string, title: string, body: string }
type CreatedIssue = { localId: string, externalId: string, title: string, url: string }
type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  tasks?: DraftTask[]
}
type Session = {
  id: string
  repositoryId: string
  status: string
  epicSummary: string | null
  messages: ChatMessage[]
  draftTasks: DraftTask[]
  createdIssues: CreatedIssue[]
  providerType: string | null
  codeContextAvailable: boolean
}

const route = useRoute()
const { api } = useApi()
const { t } = useI18n()

const repoId = computed(() => String(route.params.repoId || ''))
const session = ref<Session | null>(null)
const repoName = ref('')
const forgeType = ref('')
const workspaceStatus = ref('')
const draft = ref('')
const busy = ref('')
const message = ref('')
const messageError = ref(false)
const chatEl = ref<HTMLElement | null>(null)
let contextPollTimer: ReturnType<typeof setInterval> | null = null

const statusLabel = computed(() => {
  const s = session.value?.status || 'clarifying'
  const key = `createTasks.status.${s}` as const
  return t(key)
})

const canGenerate = computed(() => {
  if (!session.value || busy.value) return false
  if (session.value.status === 'created') return false
  return ['clarifying', 'ready_to_generate', 'draft'].includes(session.value.status)
})

const canApprove = computed(() => {
  if (!session.value || busy.value) return false
  return session.value.status === 'draft' && session.value.draftTasks.length > 0
})

const waitingForCodeContext = computed(() => {
  if (!session.value) return false
  if (session.value.codeContextAvailable) return false
  return ['not_cloned', 'queued', 'cloning', 'syncing', 'failed', 'inaccessible', ''].includes(
    workspaceStatus.value,
  )
})

async function scrollChat() {
  await nextTick()
  if (chatEl.value) {
    chatEl.value.scrollTop = chatEl.value.scrollHeight
  }
}

function stopContextPoll() {
  if (contextPollTimer) {
    clearInterval(contextPollTimer)
    contextPollTimer = null
  }
}

async function pullSessionDetail(sessionId: string) {
  const detail = await api<{
    repository: { name: string, forgeType: string, workspaceStatus: string }
    session: Session
  }>(`/api/v1/task-planning/sessions/${sessionId}`)
  session.value = detail.session
  repoName.value = detail.repository.name
  forgeType.value = detail.repository.forgeType
  workspaceStatus.value = detail.repository.workspaceStatus
  return detail
}

function startContextPoll() {
  stopContextPoll()
  if (!import.meta.client || !session.value || session.value.codeContextAvailable) return
  contextPollTimer = setInterval(() => {
    if (!session.value || busy.value) return
    void pullSessionDetail(session.value.id)
      .then(() => {
        if (session.value?.codeContextAvailable) stopContextPoll()
      })
      .catch(() => {})
  }, 5_000)
}

async function bootstrap(forceNew = false) {
  busy.value = forceNew ? 'new' : 'load'
  message.value = ''
  messageError.value = false
  try {
    const res = await api<{ session: Session }>('/api/v1/task-planning/sessions', {
      method: 'POST',
      body: {
        repositoryId: repoId.value,
        forceNew,
        resume: !forceNew,
      },
    })
    session.value = res.session
    await pullSessionDetail(res.session.id)
    await scrollChat()
    startContextPoll()
  } catch (e: unknown) {
    message.value = apiErrorMessage(e) || t('createTasks.error')
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function apiErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (e instanceof Error) return e.message
  return ''
}

await bootstrap(false)

onBeforeUnmount(() => {
  stopContextPoll()
})

async function send() {
  const content = draft.value.trim()
  if (!content || !session.value || busy.value) return
  busy.value = 'send'
  message.value = ''
  messageError.value = false
  draft.value = ''
  try {
    const res = await api<{ session: Session }>(
      `/api/v1/task-planning/sessions/${session.value.id}/messages`,
      { method: 'POST', body: { content } },
    )
    session.value = res.session
    await scrollChat()
  } catch (e: unknown) {
    draft.value = content
    message.value = apiErrorMessage(e) || t('createTasks.error')
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function generate(regenerate = false) {
  if (!session.value || busy.value) return
  busy.value = regenerate ? 'regenerate' : 'generate'
  message.value = ''
  messageError.value = false
  try {
    const res = await api<{ session: Session }>(
      `/api/v1/task-planning/sessions/${session.value.id}/generate`,
      { method: 'POST', body: { regenerate } },
    )
    session.value = res.session
    await scrollChat()
  } catch (e: unknown) {
    message.value = apiErrorMessage(e) || t('createTasks.error')
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function approve() {
  if (!session.value || !canApprove.value) return
  const count = session.value.draftTasks.length
  if (!confirm(t('createTasks.approveConfirm', { count }))) return
  busy.value = 'approve'
  message.value = ''
  messageError.value = false
  try {
    const res = await api<{ session: Session }>(
      `/api/v1/task-planning/sessions/${session.value.id}/approve`,
      { method: 'POST' },
    )
    session.value = res.session
    await scrollChat()
  } catch (e: unknown) {
    message.value = apiErrorMessage(e) || t('createTasks.error')
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}
</script>

<template>
  <div class="flex h-[calc(100vh-8rem)] min-h-[28rem] flex-col gap-4 aw-fade-in">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <UButton
          to="/create-tasks"
          variant="ghost"
          color="neutral"
          size="sm"
          icon="i-lucide-arrow-left"
          class="mb-1"
        >
          {{ t('createTasks.back') }}
        </UButton>
        <h1 class="font-display text-2xl tracking-tight md:text-3xl">
          {{ repoName || t('createTasks.title') }}
        </h1>
        <p class="mt-1 text-sm opacity-70">
          {{ forgeType === 'gitlab' ? 'GitLab' : forgeType === 'github' ? 'GitHub' : forgeType }}
          · {{ statusLabel }}
          · {{ t('createTasks.providerHint') }}
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <UBadge
            :color="session?.codeContextAvailable ? 'success' : 'warning'"
            variant="subtle"
            size="sm"
          >
            {{ session?.codeContextAvailable ? t('createTasks.codeContextOn') : t('createTasks.codeContextOff') }}
          </UBadge>
          <UBadge
            v-if="waitingForCodeContext && workspaceStatus"
            :color="workspaceStatus === 'failed' || workspaceStatus === 'inaccessible' ? 'error' : 'warning'"
            variant="subtle"
            size="sm"
          >
            {{ t('createTasks.workspaceStatus', { status: workspaceStatus }) }}
          </UBadge>
          <UBadge v-if="session?.draftTasks?.length" color="primary" variant="subtle" size="sm">
            {{ t('createTasks.draftCount', { count: session.draftTasks.length }) }}
          </UBadge>
          <UBadge v-if="session?.createdIssues?.length" color="success" variant="subtle" size="sm">
            {{ t('createTasks.createdCount', { count: session.createdIssues.length }) }}
          </UBadge>
        </div>
        <p v-if="waitingForCodeContext" class="mt-2 max-w-xl text-xs opacity-60">
          {{ t('createTasks.workspaceCloningHint') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton
          variant="soft"
          color="neutral"
          icon="i-lucide-plus"
          :loading="busy === 'new'"
          :disabled="Boolean(busy)"
          @click="bootstrap(true)"
        >
          {{ t('createTasks.newSession') }}
        </UButton>
        <UButton
          variant="soft"
          icon="i-lucide-sparkles"
          :loading="busy === 'generate'"
          :disabled="!canGenerate || Boolean(busy)"
          @click="generate(false)"
        >
          {{ t('createTasks.generate') }}
        </UButton>
        <UButton
          variant="soft"
          color="neutral"
          icon="i-lucide-refresh-cw"
          :loading="busy === 'regenerate'"
          :disabled="!session?.draftTasks?.length || session?.status === 'created' || Boolean(busy)"
          @click="generate(true)"
        >
          {{ t('createTasks.regenerate') }}
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-check-check"
          :loading="busy === 'approve'"
          :disabled="!canApprove"
          @click="approve"
        >
          {{ t('createTasks.approve') }}
        </UButton>
      </div>
    </div>

    <UAlert v-if="message" :color="messageError ? 'error' : 'success'" :title="message" variant="subtle" />

    <div class="aw-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
      <div ref="chatEl" class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
        <div
          v-for="msg in session?.messages || []"
          :key="msg.id"
          class="flex"
          :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="max-w-[min(48rem,92%)] rounded-2xl px-4 py-3 text-sm leading-relaxed"
            :class="msg.role === 'user'
              ? 'bg-[color-mix(in_oklab,var(--aw-accent)_18%,transparent)]'
              : 'bg-black/5 dark:bg-white/5'"
          >
            <p class="mb-1 text-xs font-medium opacity-60">
              {{ msg.role === 'user' ? t('createTasks.you') : t('createTasks.assistant') }}
            </p>
            <div class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
          </div>
        </div>
        <div v-if="busy === 'send' || busy === 'generate' || busy === 'regenerate' || busy === 'approve'" class="flex justify-start">
          <div class="rounded-2xl bg-black/5 px-4 py-3 text-sm opacity-70 dark:bg-white/5">
            <span class="aw-pulse-dot inline-block size-2 rounded-full bg-[var(--aw-accent)] me-2" />
            {{ t('createTasks.working') }}
          </div>
        </div>
      </div>

      <div class="border-t border-[var(--aw-line)] p-3 md:p-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
          <UTextarea
            v-model="draft"
            :placeholder="t('createTasks.composerPlaceholder')"
            :disabled="session?.status === 'created' || busy === 'load'"
            class="w-full"
            :rows="3"
            autoresize
            @keydown="onKeydown"
          />
          <UButton
            color="primary"
            icon="i-lucide-send"
            class="sm:mb-0.5"
            :loading="busy === 'send'"
            :disabled="!draft.trim() || session?.status === 'created' || Boolean(busy)"
            @click="send"
          >
            {{ t('createTasks.send') }}
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
