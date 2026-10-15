<script setup lang="ts">
const { api } = useApi()

const windowHours = ref<number>(24)
const windowOptions = [
  { label: '24h', value: 24 },
  { label: '7d', value: 168 },
]

const { data, pending, error, refresh } = await useAsyncData(
  'dashboard',
  () => api<any>(`/api/v1/dashboard?windowHours=${Number(windowHours.value) || 24}`),
  { watch: [windowHours] },
)

function statusColor(status: string | null | undefined) {
  if (!status) return 'neutral'
  if (status === 'running' || status === 'healthy' || status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'unhealthy' || status === 'error') return 'error'
  if (status === 'degraded' || status === 'unknown' || status === 'warning') return 'warning'
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

function formatPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${n}%`
}

function taskTypeLabel(taskType: string): string {
  return taskType.replace(/_/g, ' ')
}

function planLabel(service: any): string {
  if (!service?.plan) return 'Plan unknown'
  if (service.plan.plan) return service.plan.plan
  if (service.plan.error && !service.hasSecret) return 'Not connected'
  if (service.plan.error) return 'Plan unavailable'
  return 'Plan unknown'
}

function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US').format(n)
}

function formatFinishedAt(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function usageLabel(usage: any): string {
  if (!usage) return '—'
  const total = formatTokens(usage.totalTokens)
  const input = formatTokens(usage.inputTokens)
  const output = formatTokens(usage.outputTokens)
  return `${total} (in ${input} / out ${output})`
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Dashboard</h1>
        <p class="mt-1 text-sm opacity-70">
          AI service usage, plan status, and live worker metrics
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <USelect
          v-model="windowHours"
          :items="windowOptions"
          class="w-24"
          aria-label="Time window"
        />
        <UButton icon="i-lucide-refresh-cw" color="neutral" variant="soft" :loading="pending" @click="refresh()">
          Refresh
        </UButton>
      </div>
    </div>

    <UAlert v-if="error" color="error" title="Could not load dashboard" :description="String(error)" />

    <div v-if="pending && !data" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div v-for="i in 4" :key="i" class="aw-panel h-28 animate-pulse rounded-xl" />
    </div>

    <template v-else-if="data">
      <div v-if="data.warnings?.length" class="space-y-2">
        <UAlert
          v-for="(w, i) in data.warnings"
          :key="i"
          color="warning"
          :title="w"
          icon="i-lucide-triangle-alert"
        />
      </div>

      <!-- Operational KPIs -->
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div class="aw-panel rounded-xl p-4">
          <p class="text-xs uppercase tracking-wide opacity-60">Repositories</p>
          <p class="mt-2 font-display text-3xl">{{ data.repositories.total }}</p>
          <p class="text-sm opacity-70">{{ data.repositories.enabled }} enabled</p>
        </div>
        <div class="aw-panel rounded-xl p-4">
          <p class="text-xs uppercase tracking-wide opacity-60">Worker</p>
          <div class="mt-2 flex items-center gap-2">
            <span class="aw-pulse-dot inline-block size-2 rounded-full bg-[var(--aw-accent)]" />
            <UBadge :color="statusColor(data.worker.status)" variant="subtle">{{ data.worker.status }}</UBadge>
          </div>
          <p class="mt-2 text-sm opacity-70">
            {{ data.worker.activeTaskCount || 0 }} active
            · default {{ data.settings?.defaultAiProvider || '—' }}
          </p>
        </div>
        <div class="aw-panel rounded-xl p-4">
          <p class="text-xs uppercase tracking-wide opacity-60">Forge queue</p>
          <p class="mt-2 font-display text-3xl">
            {{ data.queue?.working || 0 }} / {{ data.queue?.queued || 0 }}
          </p>
          <p class="text-sm opacity-70">working / waiting · {{ data.queue?.total || 0 }} labeled</p>
        </div>
        <div class="aw-panel rounded-xl p-4">
          <p class="text-xs uppercase tracking-wide opacity-60">Success · {{ data.windowHours }}h</p>
          <p class="mt-2 font-display text-3xl">{{ formatPct(data.tasks.successRate) }}</p>
          <p class="text-sm opacity-70">
            {{ data.tasks.succeeded }} ok / {{ data.tasks.failed }} fail
            · avg {{ formatDuration(data.tasks.avgDurationMs) }}
          </p>
        </div>
      </div>

      <!-- AI services: plan + usage -->
      <section class="space-y-3">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 class="font-display text-xl">AI services</h2>
            <p class="text-sm opacity-70">
              Plan / account and recorded usage for the selected window
            </p>
          </div>
          <NuxtLink to="/providers" class="text-sm text-[var(--aw-accent)] underline-offset-2 hover:underline">
            Manage providers
          </NuxtLink>
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <div
            v-for="svc in data.aiServices"
            :key="svc.providerType"
            class="aw-panel space-y-4 rounded-xl p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="font-display text-xl">{{ svc.displayName }}</h3>
                  <UBadge v-if="svc.isDefault" color="primary" variant="subtle">default</UBadge>
                  <UBadge :color="svc.isEnabled ? 'success' : 'neutral'" variant="subtle">
                    {{ svc.isEnabled ? 'enabled' : 'disabled' }}
                  </UBadge>
                </div>
                <p class="mt-1 text-sm opacity-60">{{ svc.providerType }}</p>
              </div>
              <UBadge :color="statusColor(svc.healthStatus)" variant="subtle">
                {{ svc.healthStatus || 'unknown' }}
              </UBadge>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="rounded-lg border border-[var(--aw-line)] bg-black/[0.02] p-3 dark:bg-white/[0.03]">
                <p class="text-xs uppercase tracking-wide opacity-60">Plan / account</p>
                <p class="mt-1 font-display text-2xl tracking-tight">{{ planLabel(svc) }}</p>
                <p class="mt-1 truncate text-sm opacity-70">
                  {{ svc.plan?.accountLabel || svc.plan?.email || (svc.hasSecret ? 'Credentials connected' : 'No credentials') }}
                </p>
                <p v-if="svc.plan?.model || svc.plan?.cliVersion" class="mt-1 text-xs opacity-55">
                  <span v-if="svc.plan?.model">Model {{ svc.plan.model }}</span>
                  <span v-if="svc.plan?.model && svc.plan?.cliVersion"> · </span>
                  <span v-if="svc.plan?.cliVersion">CLI {{ svc.plan.cliVersion }}</span>
                </p>
              </div>

              <div class="rounded-lg border border-[var(--aw-line)] bg-black/[0.02] p-3 dark:bg-white/[0.03]">
                <p class="text-xs uppercase tracking-wide opacity-60">Usage · {{ data.windowHours }}h</p>
                <p class="mt-1 font-display text-2xl tracking-tight">{{ svc.usage?.runs || 0 }} runs</p>
                <p class="mt-1 text-sm opacity-70">
                  {{ svc.usage?.succeeded || 0 }} ok
                  · {{ svc.usage?.failed || 0 }} fail
                  · {{ formatPct(svc.usage?.successRate) }} success
                </p>
                <p class="mt-1 text-xs opacity-55">
                  avg {{ formatDuration(svc.usage?.avgDurationMs) }}
                  · total {{ formatDuration(svc.usage?.totalDurationMs) }}
                  <span v-if="svc.usage?.running"> · {{ svc.usage.running }} running</span>
                </p>
              </div>
            </div>

            <div v-if="svc.usage?.byTaskType?.length" class="space-y-2">
              <p class="text-xs uppercase tracking-wide opacity-60">By task type</p>
              <ul class="space-y-1.5">
                <li
                  v-for="row in svc.usage.byTaskType.slice(0, 5)"
                  :key="row.taskType"
                  class="flex items-center justify-between gap-3 text-sm"
                >
                  <span class="min-w-0 truncate opacity-80">{{ taskTypeLabel(row.taskType) }}</span>
                  <span class="shrink-0 tabular-nums opacity-70">
                    {{ row.runs }}
                    <span class="opacity-50">({{ row.succeeded }}/{{ row.failed }})</span>
                  </span>
                </li>
              </ul>
            </div>
            <p v-else class="text-sm opacity-55">
              No runs recorded for this provider in the window.
              <span v-if="svc.providerType === 'unassigned'">
                Older runs may lack a provider tag until the worker is updated.
              </span>
            </p>

            <p v-if="svc.healthMessage" class="text-xs opacity-55">{{ svc.healthMessage }}</p>
          </div>
        </div>
      </section>

      <!-- Finished tasks: status + token usage -->
      <section class="space-y-3">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 class="font-display text-xl">Finished tasks</h2>
            <p class="text-sm opacity-70">
              Completed runs in the selected window · status and token usage
            </p>
          </div>
          <NuxtLink to="/tasks" class="text-sm text-[var(--aw-accent)] underline-offset-2 hover:underline">
            All tasks
          </NuxtLink>
        </div>

        <div v-if="!data.finishedTasks?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
          No finished tasks in the last {{ data.windowHours }}h.
        </div>
        <div v-else class="aw-panel overflow-x-auto rounded-xl">
          <table class="min-w-full text-sm">
            <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
              <tr>
                <th class="px-4 py-3">Task</th>
                <th class="px-4 py-3">Repo</th>
                <th class="px-4 py-3">Type</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3">Provider</th>
                <th class="px-4 py-3">Duration</th>
                <th class="px-4 py-3">Tokens</th>
                <th class="px-4 py-3">Finished</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="run in data.finishedTasks"
                :key="run.id"
                class="border-b border-[var(--aw-line)]"
              >
                <td class="px-4 py-3">
                  <NuxtLink :to="`/tasks/${run.id}`" class="font-medium hover:underline">
                    {{ run.title || `#${run.externalId}` }}
                  </NuxtLink>
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
                      ? `cache read ${formatTokens(run.usage.cacheReadTokens)} · cache write ${formatTokens(run.usage.cacheWriteTokens)}`
                      : 'Token usage not recorded for this run'"
                  >
                    {{ usageLabel(run.usage) }}
                  </span>
                </td>
                <td class="px-4 py-3 whitespace-nowrap opacity-70">{{ formatFinishedAt(run.finishedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="aw-panel rounded-xl p-4">
          <div class="flex items-center justify-between gap-2">
            <h2 class="font-display text-xl">Recent executions</h2>
            <NuxtLink to="/tasks" class="text-sm text-[var(--aw-accent)] underline-offset-2 hover:underline">
              All tasks
            </NuxtLink>
          </div>
          <div v-if="!data.recentRuns.length" class="mt-4 text-sm opacity-60">No executions recorded yet.</div>
          <ul v-else class="mt-4 divide-y divide-[var(--aw-line)]">
            <li v-for="run in data.recentRuns" :key="run.id" class="flex items-center justify-between gap-3 py-3 text-sm">
              <div class="min-w-0">
                <NuxtLink :to="`/tasks/${run.id}`" class="truncate font-medium hover:underline">
                  {{ run.title || `${run.taskType} #${run.externalId}` }}
                </NuxtLink>
                <p class="truncate opacity-60">
                  {{ run.provider || 'provider n/a' }}
                  · {{ formatDuration(run.durationMs) }}
                  · {{ run.status }}
                </p>
              </div>
              <UBadge :color="statusColor(run.status)" variant="subtle">{{ run.status }}</UBadge>
            </li>
          </ul>
        </div>

        <div class="aw-panel rounded-xl p-4">
          <h2 class="font-display text-xl">Operational events</h2>
          <div v-if="!data.recentEvents.length" class="mt-4 text-sm opacity-60">No worker events yet.</div>
          <ul v-else class="mt-4 divide-y divide-[var(--aw-line)]">
            <li v-for="ev in data.recentEvents" :key="ev.id" class="py-3 text-sm">
              <p class="font-medium">{{ ev.eventType }}</p>
              <p class="opacity-60">{{ ev.message || '—' }}</p>
            </li>
          </ul>
        </div>
      </div>

      <div class="aw-panel rounded-xl p-4">
        <h2 class="font-display text-xl">Latest failures</h2>
        <div v-if="!data.latestFailures.length" class="mt-4 text-sm opacity-60">No recent failures in the loaded set.</div>
        <ul v-else class="mt-4 space-y-2">
          <li v-for="run in data.latestFailures" :key="run.id" class="text-sm">
            <NuxtLink :to="`/tasks/${run.id}`" class="font-medium hover:underline">
              {{ run.title || run.externalId }}
            </NuxtLink>
            <span class="opacity-60"> — {{ run.errorSummary || 'No summary' }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
