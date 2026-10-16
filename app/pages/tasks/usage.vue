<script setup lang="ts">
const { api } = useApi()
const { t, intlLocale } = useI18n()

const page = ref(1)
const windowHours = ref<number | null>(null)
const windowOptions = [
  { label: 'All time', value: null },
  { label: '24h', value: 24 },
  { label: '7d', value: 168 },
]

const qs = computed(() => {
  const p = new URLSearchParams({ page: String(page.value), pageSize: '20' })
  if (windowHours.value != null) p.set('windowHours', String(windowHours.value))
  else p.set('windowHours', 'all')
  return p.toString()
})

type FinishedUsagePage = {
  items: Array<{
    id: string
    title: string | null
    externalId: string
    taskType: string
    provider: string | null
    status: string
    repositoryName: string | null
    durationMs: number | null
    finishedAt: string | null
    usage: {
      totalTokens: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    } | null
  }>
  page: number
  pageSize: number
  total: number
}

const { data, pending, error, refresh } = await useAsyncData(
  'finished-task-usage',
  () => api<FinishedUsagePage>(`/api/v1/runs/finished?${qs.value}`),
  { watch: [qs] },
)

watch(windowHours, () => {
  page.value = 1
})

function statusColor(status: string | null | undefined) {
  if (!status) return 'neutral'
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'cancelled' || status === 'interrupted') return 'warning'
  return 'neutral'
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`
}

function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat(intlLocale.value).format(n)
}

function formatFinishedAt(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(intlLocale.value)
}

function taskTypeLabel(taskType: string): string {
  return taskType.replace(/_/g, ' ')
}

function usageLabel(usage: FinishedUsagePage['items'][number]['usage']): string {
  if (!usage) return '—'
  return t('dashboard.usageDetail', {
    total: formatTokens(usage.totalTokens),
    input: formatTokens(usage.inputTokens),
    output: formatTokens(usage.outputTokens),
  })
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="text-sm opacity-60">
          <NuxtLink to="/" class="hover:underline">{{ t('nav.dashboard') }}</NuxtLink>
          <span class="mx-1">·</span>
          <NuxtLink to="/tasks" class="hover:underline">{{ t('nav.tasks') }}</NuxtLink>
        </p>
        <h1 class="font-display text-3xl tracking-tight">{{ t('dashboard.finishedTasks') }}</h1>
        <p class="mt-1 text-sm opacity-70">
          {{ t('dashboard.finishedTasksHint') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <USelect v-model="windowHours" :items="windowOptions" class="w-36" />
        <UButton
          color="neutral"
          variant="soft"
          icon="i-lucide-refresh-cw"
          :loading="pending"
          @click="refresh()"
        >
          Refresh
        </UButton>
      </div>
    </div>

    <UAlert v-if="error" color="error" title="Could not load finished tasks" :description="String(error)" />

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      <template v-if="windowHours != null">
        {{ t('dashboard.noFinishedTasks', { hours: windowHours }) }}
      </template>
      <template v-else>
        No finished tasks recorded yet.
      </template>
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-start opacity-70">
          <tr>
            <th class="px-4 py-3">{{ t('dashboard.col.task') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.repo') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.type') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.status') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.provider') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.duration') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.tokens') }}</th>
            <th class="px-4 py-3">{{ t('dashboard.col.finished') }}</th>
            <th class="px-4 py-3 text-right">Details</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="run in data.items"
            :key="run.id"
            class="border-b border-[var(--aw-line)]"
          >
            <td class="px-4 py-3">
              <p class="font-medium">{{ run.title || `#${run.externalId}` }}</p>
              <p class="mt-0.5 text-xs opacity-50">#{{ run.externalId }}</p>
            </td>
            <td class="px-4 py-3">{{ run.repositoryName || '—' }}</td>
            <td class="px-4 py-3">{{ taskTypeLabel(run.taskType) }}</td>
            <td class="px-4 py-3">
              <UBadge :color="statusColor(run.status)" variant="subtle">{{ run.status }}</UBadge>
            </td>
            <td class="px-4 py-3">{{ run.provider || '—' }}</td>
            <td class="px-4 py-3 tabular-nums">{{ formatDuration(run.durationMs) }}</td>
            <td class="px-4 py-3">
              <span
                class="tabular-nums"
                :title="run.usage
                  ? t('dashboard.tokensDetail', {
                    read: formatTokens(run.usage.cacheReadTokens),
                    write: formatTokens(run.usage.cacheWriteTokens),
                  })
                  : t('dashboard.tokensNotRecorded')"
              >
                {{ usageLabel(run.usage) }}
              </span>
            </td>
            <td class="px-4 py-3 whitespace-nowrap opacity-70">{{ formatFinishedAt(run.finishedAt) }}</td>
            <td class="px-4 py-3 text-right">
              <NuxtLink :to="`/tasks/${run.id}`" class="text-xs underline opacity-70">
                details
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex items-center justify-between px-4 py-3 text-sm opacity-70">
        <span>{{ data.total }} total</span>
        <div class="flex gap-2">
          <UButton size="xs" :disabled="page <= 1" @click="page--">Prev</UButton>
          <UButton size="xs" :disabled="page * data.pageSize >= data.total" @click="page++">Next</UButton>
        </div>
      </div>
    </div>
  </div>
</template>
