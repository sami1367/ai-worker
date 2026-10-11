<script setup lang="ts">
const { api } = useApi()
const { data, pending, error, refresh } = await useAsyncData('dashboard', () =>
  api<any>('/api/v1/dashboard?windowHours=24'),
)

function statusColor(status: string) {
  if (status === 'running' || status === 'healthy' || status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'unhealthy' || status === 'error') return 'error'
  if (status === 'degraded' || status === 'unknown') return 'warning'
  return 'neutral'
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Dashboard</h1>
        <p class="mt-1 text-sm opacity-70">Last 24 hours · live API data</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="soft" :loading="pending" @click="refresh()">
        Refresh
      </UButton>
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
            {{ data.worker.heartbeatStale ? 'Heartbeat stale / unavailable' : 'Heartbeat fresh' }}
          </p>
        </div>
        <div class="aw-panel rounded-xl p-4">
          <p class="text-xs uppercase tracking-wide opacity-60">Running / queued</p>
          <p class="mt-2 font-display text-3xl">{{ data.tasks.running }} / {{ data.tasks.queued }}</p>
          <p class="text-sm opacity-70">From recorded task_runs</p>
        </div>
        <div class="aw-panel rounded-xl p-4">
          <p class="text-xs uppercase tracking-wide opacity-60">Succeeded / failed</p>
          <p class="mt-2 font-display text-3xl">{{ data.tasks.succeeded }} / {{ data.tasks.failed }}</p>
          <p class="text-sm opacity-70">{{ data.windowHours }}h window</p>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="aw-panel rounded-xl p-4">
          <h2 class="font-display text-xl">Recent executions</h2>
          <div v-if="!data.recentRuns.length" class="mt-4 text-sm opacity-60">No executions recorded yet.</div>
          <ul v-else class="mt-4 divide-y divide-[var(--aw-line)]">
            <li v-for="run in data.recentRuns" :key="run.id" class="flex items-center justify-between gap-3 py-3 text-sm">
              <div class="min-w-0">
                <NuxtLink :to="`/tasks/${run.id}`" class="truncate font-medium hover:underline">
                  {{ run.title || `${run.taskType} #${run.externalId}` }}
                </NuxtLink>
                <p class="truncate opacity-60">{{ run.provider || 'provider n/a' }} · {{ run.status }}</p>
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
