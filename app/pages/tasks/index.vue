<script setup lang="ts">
const { api } = useApi()
const page = ref(1)
const q = ref('')
const status = ref<string | null>(null)
const taskType = ref<string | null>(null)
const provider = ref<string | null>(null)
const busy = ref('')
const message = ref('')
const messageColor = ref<'success' | 'error' | 'neutral'>('neutral')

const statusItems = [
  { label: 'Any status', value: null },
  { label: 'queued', value: 'queued' },
  { label: 'running', value: 'running' },
  { label: 'succeeded', value: 'succeeded' },
  { label: 'failed', value: 'failed' },
  { label: 'cancelled', value: 'cancelled' },
  { label: 'interrupted', value: 'interrupted' },
]
const providerItems = [
  { label: 'Any provider', value: null },
  { label: 'cursor', value: 'cursor' },
  { label: 'claude', value: 'claude' },
  { label: 'codex', value: 'codex' },
  { label: 'gemini', value: 'gemini' },
  { label: 'copilot', value: 'copilot' },
]
const taskTypeItems = [
  { label: 'Any type', value: null },
  { label: 'github_issue', value: 'github_issue' },
  { label: 'gitlab_issue', value: 'gitlab_issue' },
  { label: 'github_pr_review', value: 'github_pr_review' },
  { label: 'gitlab_mr_review', value: 'gitlab_mr_review' },
  { label: 'github_pr_implement', value: 'github_pr_implement' },
  { label: 'gitlab_mr_implement', value: 'gitlab_mr_implement' },
  { label: 'release', value: 'release' },
]

const qs = computed(() => {
  const p = new URLSearchParams({ page: String(page.value), pageSize: '20' })
  if (q.value) p.set('q', q.value)
  if (status.value) p.set('status', status.value)
  if (taskType.value) p.set('taskType', taskType.value)
  if (provider.value) p.set('provider', provider.value)
  return p.toString()
})

const liveStatus = ref<'connecting' | 'live' | 'polling'>('connecting')

const {
  data: queue,
  pending: queuePending,
  refresh: refreshQueue,
  error: queueError,
} = await useAsyncData('tasks-queue', () => api<any>('/api/v1/tasks/queue'), {
  server: false,
})

const { data: history, pending: historyPending, refresh: refreshHistory } = await useAsyncData(
  'tasks-history',
  () => api<any>(`/api/v1/runs?${qs.value}`),
  { watch: [qs] },
)

function applyQueueSnapshot(next: unknown) {
  if (!next || typeof next !== 'object') return
  queue.value = next as typeof queue.value
  liveStatus.value = 'live'
  // Keep history fresh when assignment / runs change
  void refreshHistory().catch(() => {})
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
let ws: WebSocket | null = null
let es: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function clearLiveConnections() {
  if (ws) {
    try { ws.close() } catch { /* ignore */ }
    ws = null
  }
  if (es) {
    try { es.close() } catch { /* ignore */ }
    es = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function startPollingFallback() {
  liveStatus.value = 'polling'
  if (refreshTimer) return
  refreshTimer = setInterval(() => {
    refreshQueue().catch(() => {})
  }, 30_000)
}

function connectLiveQueue() {
  if (!import.meta.client) return
  clearLiveConnections()

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl = `${proto}://${location.host}/ws/tasks-queue`

  try {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => {
      liveStatus.value = 'live'
      if (refreshTimer) {
        clearInterval(refreshTimer)
        refreshTimer = null
      }
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data))
        if (msg?.type === 'queue' && msg.queue) applyQueueSnapshot(msg.queue)
      } catch { /* ignore malformed */ }
    }
    ws.onerror = () => {
      // Fall through to SSE on close
    }
    ws.onclose = () => {
      ws = null
      connectSseFallback()
    }
    return
  } catch {
    connectSseFallback()
  }
}

function connectSseFallback() {
  if (!import.meta.client) return
  if (es) return

  es = new EventSource('/api/v1/tasks/queue/stream', { withCredentials: true })
  es.onopen = () => {
    liveStatus.value = 'live'
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg?.type === 'queue' && msg.queue) applyQueueSnapshot(msg.queue)
    } catch { /* ignore */ }
  }
  es.onerror = () => {
    es?.close()
    es = null
    startPollingFallback()
    reconnectTimer = setTimeout(() => {
      connectLiveQueue()
    }, 10_000)
  }
}

async function syncFromForge() {
  busy.value = 'sync'
  message.value = ''
  try {
    await api('/api/v1/tasks/queue/sync', { method: 'POST' })
    await refreshQueue()
    messageColor.value = 'success'
    message.value = 'Synced queue from GitHub/GitLab into the database'
  } catch (e: any) {
    messageColor.value = 'error'
    message.value = e?.data?.message || 'Queue sync failed'
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  connectLiveQueue()
})
onBeforeUnmount(() => {
  clearLiveConnections()
  if (refreshTimer) clearInterval(refreshTimer)
})

function fmtDuration(ms?: number | null) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 1000)}s`
}

function statusColor(s: string) {
  if (s === 'running' || s === 'working' || s === 'reviewing' || s === 'succeeded') return 'success'
  if (s === 'failed' || s === 'error') return 'error'
  if (s === 'queued' || s === 'review_queued' || s === 'unknown' || s === 'starting') return 'warning'
  return 'neutral'
}

function phaseColor(phase: string) {
  if (phase === 'working' || phase === 'reviewing') return 'success'
  if (phase === 'failed') return 'error'
  if (phase === 'queued' || phase === 'review_queued') return 'warning'
  return 'neutral'
}

function taskTypeLabel(taskType: string) {
  const map: Record<string, string> = {
    github_issue: 'Issue implement',
    gitlab_issue: 'Issue implement',
    github_pr_implement: 'PR implement',
    gitlab_mr_implement: 'MR implement',
    github_pr_review: 'PR AI review',
    gitlab_mr_review: 'MR AI review',
    release: 'Release',
  }
  return map[taskType] || taskType
}

function workerLabel(item: any) {
  const w = item?.assignedWorker
  if (!w) return '—'
  const parts = [
    w.hostname || null,
    w.pid != null ? `pid ${w.pid}` : null,
    w.repositoryName && w.repositoryName !== item.repositoryName ? w.repositoryName : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Assigned'
}

const repositories = computed(() => {
  if (queue.value?.byRepository?.length) return queue.value.byRepository
  // Fallback: group flat items when older API has no byRepository
  const map = new Map<string, any>()
  for (const item of queue.value?.items || []) {
    const key = item.repositoryId || item.repositoryName
    if (!map.has(key)) {
      map.set(key, {
        repositoryId: item.repositoryId,
        repositoryName: item.repositoryName,
        forgeType: item.forgeType,
        itemCount: 0,
        busy: false,
        error: null,
        items: [] as any[],
      })
    }
    const row = map.get(key)
    row.items.push(item)
    row.itemCount++
    if (item.phase === 'working' || item.phase === 'reviewing' || item.assignedWorker) row.busy = true
  }
  return [...map.values()].sort((a, b) => String(a.repositoryName).localeCompare(String(b.repositoryName)))
})

function reasonColor(reason: string | null | undefined, phase: string) {
  if (!reason) {
    if (phase === 'working' || phase === 'reviewing') return 'success'
    return 'neutral'
  }
  if (reason.startsWith('Next')) return 'primary'
  if (reason.startsWith('Done')) return 'neutral'
  if (reason.includes('failed') || reason.includes('stopped') || reason.includes('stale')) return 'error'
  return 'warning'
}

async function control(action: 'start' | 'stop') {
  const label = action === 'start' ? 'start' : 'stop'
  if (!confirm(`Confirm worker ${label}? Active AI runs are not force-killed on graceful stop.`)) return
  busy.value = action
  message.value = ''
  try {
    const res = await api<any>(`/api/v1/worker/${action}`, { method: 'POST' })
    messageColor.value = 'success'
    message.value = `Requested ${label}: ${res.status}${res.deduplicated ? ' (deduplicated)' : ''}`
    await refreshQueue()
  } catch (e: any) {
    messageColor.value = 'error'
    message.value = e?.data?.message || `${label} failed`
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Tasks</h1>
        <p class="mt-1 text-sm opacity-70">
          Queue from database · live updates · worker assignment · run history
          <span v-if="queue?.syncedAt" class="opacity-60"> · synced {{ new Date(queue.syncedAt).toLocaleString() }}</span>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          :color="liveStatus === 'live' ? 'success' : liveStatus === 'polling' ? 'warning' : 'neutral'"
          variant="subtle"
        >
          {{ liveStatus === 'live' ? 'Live' : liveStatus === 'polling' ? 'Polling' : 'Connecting…' }}
        </UBadge>
        <UBadge
          v-if="queue?.worker"
          :color="statusColor(queue.worker.status)"
          variant="subtle"
        >
          Worker: {{ queue.worker.status }}
          <span v-if="queue.worker.activeTaskCount"> · {{ queue.worker.activeTaskCount }} active</span>
        </UBadge>
        <UButton
          color="neutral"
          variant="soft"
          icon="i-lucide-database"
          :loading="busy === 'sync'"
          @click="syncFromForge()"
        >
          Sync forges
        </UButton>
        <UButton
          color="neutral"
          variant="soft"
          icon="i-lucide-refresh-cw"
          :loading="queuePending"
          @click="refreshQueue()"
        >
          Refresh
        </UButton>
      </div>
    </div>

    <UAlert v-if="message" :color="messageColor" :title="message" />
    <UAlert v-if="queueError" color="error" title="Could not load live queue" :description="String(queueError)" />
    <UAlert
      v-if="queue?.errors?.length"
      color="warning"
      :title="`Could not poll ${queue.errors.length} repositor${queue.errors.length === 1 ? 'y' : 'ies'}`"
      :description="queue.errors.slice(0, 5).map((e: any) => `${e.repositoryName}: ${e.message}`).join(' · ') + (queue.errors.length > 5 ? ' · …' : '')"
    />

    <!-- Next task -->
    <div class="aw-panel rounded-xl p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-xs uppercase tracking-wide opacity-60">Next task</p>
          <template v-if="queuePending && !queue">
            <div class="mt-3 h-16 w-72 animate-pulse rounded-lg bg-black/5 dark:bg-white/5" />
          </template>
          <template v-else-if="queue?.nextTask">
            <h2 class="mt-1 font-display text-2xl tracking-tight">
              {{ queue.nextTask.title }}
            </h2>
            <p class="mt-1 text-sm opacity-70">
              {{ queue.nextTask.repositoryName }}
              · {{ taskTypeLabel(queue.nextTask.taskType) }}
              · {{ queue.nextTask.phaseLabel }}
              <template v-if="queue.nextTask.branch || queue.nextTask.sourceBranch">
                · <code class="text-xs">{{ queue.nextTask.branch || queue.nextTask.sourceBranch }}</code>
              </template>
            </p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <UBadge
                v-for="label in queue.nextTask.labels"
                :key="label"
                size="sm"
                color="neutral"
                variant="subtle"
              >
                {{ label }}
              </UBadge>
            </div>
          </template>
          <template v-else>
            <h2 class="mt-1 font-display text-2xl tracking-tight">No queued task</h2>
            <p class="mt-1 text-sm opacity-70">
              Label an issue with <code class="text-xs">ai</code> or a PR/MR with <code class="text-xs">ai-review</code>.
            </p>
          </template>
        </div>
        <a
          v-if="queue?.nextTask?.url"
          :href="queue.nextTask.url"
          target="_blank"
          class="text-sm text-[var(--aw-accent)] hover:underline"
        >
          Open on forge
        </a>
      </div>
    </div>

    <!-- Live queue by repository -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="font-display text-xl">Queue by repository</h2>
        <p class="mt-1 text-sm opacity-70">
          Stored AI-labeled issues and PR/MRs · why idle · forge labels
        </p>
      </div>
      <p v-if="queue" class="text-sm opacity-60">
        {{ queue.items?.length || 0 }} item{{ (queue.items?.length || 0) === 1 ? '' : 's' }}
        · {{ repositories.length }} repositor{{ repositories.length === 1 ? 'y' : 'ies' }}
      </p>
    </div>

    <div v-if="queuePending && !queue" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!repositories.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No enabled repositories. Enable repos under Repositories to see their AI labels here.
    </div>
    <div v-else class="space-y-4">
      <div
        v-for="repo in repositories"
        :key="repo.repositoryId"
        class="aw-panel overflow-x-auto rounded-xl"
      >
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--aw-line)] px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <NuxtLink
              :to="`/repositories/${repo.repositoryId}`"
              class="font-display text-lg hover:underline"
            >
              {{ repo.repositoryName }}
            </NuxtLink>
            <UBadge size="sm" color="neutral" variant="subtle">{{ repo.forgeType }}</UBadge>
            <UBadge
              v-if="repo.busy"
              size="sm"
              color="success"
              variant="subtle"
            >
              Working
            </UBadge>
            <UBadge
              v-else-if="repo.blockReason"
              size="sm"
              color="warning"
              variant="subtle"
            >
              Not starting new issues
            </UBadge>
            <UBadge
              v-else-if="repo.error"
              size="sm"
              color="error"
              variant="subtle"
            >
              Poll error
            </UBadge>
            <UBadge
              v-else-if="!repo.itemCount"
              size="sm"
              color="neutral"
              variant="subtle"
            >
              Idle · no AI labels
            </UBadge>
            <UBadge
              v-else
              size="sm"
              color="warning"
              variant="subtle"
            >
              {{ repo.itemCount }} open
            </UBadge>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <UButton
              size="xs"
              icon="i-lucide-play"
              :loading="busy === 'start'"
              :disabled="!!busy && busy !== 'start'"
              @click="control('start')"
            >
              Start
            </UButton>
            <UButton
              size="xs"
              color="warning"
              variant="soft"
              icon="i-lucide-square"
              :loading="busy === 'stop'"
              :disabled="!!busy && busy !== 'stop'"
              @click="control('stop')"
            >
              Stop
            </UButton>
          </div>
        </div>

        <p v-if="repo.error" class="border-b border-[var(--aw-line)] px-4 py-2 text-sm text-[var(--aw-danger,#b91c1c)]">
          {{ repo.error }}
        </p>
        <p
          v-if="repo.blockReason"
          class="border-b border-[var(--aw-line)] bg-amber-500/10 px-4 py-2.5 text-sm"
        >
          {{ repo.blockReason }}
        </p>

        <div v-if="!repo.items?.length" class="px-4 py-6 text-sm opacity-60">
          <template v-if="repo.blockReason">
            Worker is skipping new issues for this repository (see reason above).
          </template>
          <template v-else>
            No open AI-labeled issues or PR/MRs on this repository.
          </template>
        </div>
        <table v-else class="min-w-full text-sm">
          <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
            <tr>
              <th class="px-4 py-3">Title</th>
              <th class="px-4 py-3">Type</th>
              <th class="px-4 py-3">Phase</th>
              <th class="px-4 py-3">Branch</th>
              <th class="px-4 py-3">Status / why not working</th>
              <th class="px-4 py-3">Worker</th>
              <th class="px-4 py-3">Labels</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in repo.items"
              :key="item.id"
              class="border-b border-[var(--aw-line)]"
              :class="item.isNext ? 'bg-black/[0.03] dark:bg-white/[0.04]' : ''"
            >
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <UBadge v-if="item.isNext" size="sm" color="primary" variant="subtle">Next</UBadge>
                  <a
                    v-if="item.url"
                    :href="item.url"
                    target="_blank"
                    class="font-medium hover:underline"
                  >
                    {{ item.title || `#${item.externalId}` }}
                  </a>
                  <span v-else class="font-medium">{{ item.title || `#${item.externalId}` }}</span>
                </div>
                <p class="mt-0.5 text-xs opacity-50">#{{ item.externalId }} · {{ item.kind }}</p>
              </td>
              <td class="px-4 py-3">{{ taskTypeLabel(item.taskType) }}</td>
              <td class="px-4 py-3">
                <UBadge :color="phaseColor(item.phase)" variant="subtle">{{ item.phaseLabel }}</UBadge>
              </td>
              <td class="px-4 py-3">
                <code
                  v-if="item.branch || item.sourceBranch"
                  class="rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10"
                  :title="item.phase === 'working' || item.phase === 'reviewing' || item.assignedWorker ? 'Branch currently being worked on' : 'Related branch'"
                >
                  {{ item.branch || item.sourceBranch }}
                </code>
                <span v-else class="opacity-50">—</span>
              </td>
              <td class="px-4 py-3">
                <span
                  v-if="!item.statusReason && (item.phase === 'working' || item.phase === 'reviewing' || item.assignedWorker)"
                  class="text-[var(--aw-accent)]"
                >
                  In progress
                </span>
                <UBadge
                  v-else-if="item.statusReason"
                  :color="reasonColor(item.statusReason, item.phase)"
                  variant="subtle"
                  class="max-w-xs whitespace-normal text-left"
                >
                  {{ item.statusReason }}
                </UBadge>
                <span v-else class="opacity-50">—</span>
              </td>
              <td class="px-4 py-3">
                <span v-if="item.assignedWorker" class="inline-flex items-center gap-1.5">
                  <span class="aw-pulse-dot inline-block size-1.5 rounded-full bg-[var(--aw-accent)]" />
                  {{ workerLabel(item) }}
                </span>
                <span v-else class="opacity-50">—</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <UBadge
                    v-for="label in item.labels"
                    :key="label"
                    size="sm"
                    color="neutral"
                    variant="subtle"
                  >
                    {{ label }}
                  </UBadge>
                  <span v-if="!item.labels?.length" class="opacity-50">—</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- History -->
    <div>
      <h2 class="font-display text-xl">Execution history</h2>
      <p class="mt-1 text-sm opacity-70">Past and in-progress runs recorded in PostgreSQL</p>
    </div>

    <div class="aw-panel flex flex-wrap gap-3 rounded-xl p-4">
      <UInput v-model="q" placeholder="Search title / id…" class="min-w-56" />
      <USelect v-model="status" :items="statusItems" placeholder="Any status" class="w-44" />
      <USelect v-model="provider" :items="providerItems" placeholder="Any provider" class="w-40" />
      <USelect v-model="taskType" :items="taskTypeItems" placeholder="Any type" class="w-56" />
    </div>

    <div v-if="historyPending && !history" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!history?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No task runs recorded yet.
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
            <th class="px-4 py-3">Title</th>
            <th class="px-4 py-3">Repo</th>
            <th class="px-4 py-3">Type</th>
            <th class="px-4 py-3">Status</th>
            <th class="px-4 py-3">Provider</th>
            <th class="px-4 py-3">Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in history.items" :key="run.id" class="border-b border-[var(--aw-line)]">
            <td class="px-4 py-3">
              <NuxtLink :to="`/tasks/${run.id}`" class="font-medium hover:underline">
                {{ run.title || `#${run.externalId}` }}
              </NuxtLink>
              <a v-if="run.externalUrl" :href="run.externalUrl" target="_blank" class="ml-2 text-xs opacity-60 hover:underline">external</a>
            </td>
            <td class="px-4 py-3">{{ run.repositoryName || '—' }}</td>
            <td class="px-4 py-3">{{ taskTypeLabel(run.taskType) }}</td>
            <td class="px-4 py-3">
              <UBadge :color="statusColor(run.status)" variant="subtle">{{ run.status }}</UBadge>
            </td>
            <td class="px-4 py-3">{{ run.provider || '—' }}</td>
            <td class="px-4 py-3">{{ fmtDuration(run.durationMs) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="flex justify-between px-4 py-3 text-sm opacity-70">
        <span>{{ history.total }} total</span>
        <div class="flex gap-2">
          <UButton size="xs" :disabled="page <= 1" @click="page--">Prev</UButton>
          <UButton size="xs" :disabled="page * history.pageSize >= history.total" @click="page++">Next</UButton>
        </div>
      </div>
    </div>
  </div>
</template>
