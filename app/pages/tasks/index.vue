<script setup lang="ts">
const { api } = useApi()
const page = ref(1)
const q = ref('')
const status = ref('')
const taskType = ref('')
const provider = ref('')

const qs = computed(() => {
  const p = new URLSearchParams({ page: String(page.value), pageSize: '20' })
  if (q.value) p.set('q', q.value)
  if (status.value) p.set('status', status.value)
  if (taskType.value) p.set('taskType', taskType.value)
  if (provider.value) p.set('provider', provider.value)
  return p.toString()
})

const { data, pending } = await useAsyncData(
  'tasks',
  () => api<any>(`/api/v1/runs?${qs.value}`),
  { watch: [qs] },
)

function fmtDuration(ms?: number | null) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 1000)}s`
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">Tasks</h1>
      <p class="mt-1 text-sm opacity-70">Execution history from PostgreSQL</p>
    </div>

    <div class="aw-panel flex flex-wrap gap-3 rounded-xl p-4">
      <UInput v-model="q" placeholder="Search title / id…" class="min-w-56" />
      <USelect
        v-model="status"
        :items="['', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].map((v) => ({ label: v || 'Any status', value: v }))"
        class="w-44"
      />
      <USelect
        v-model="provider"
        :items="['', 'cursor', 'claude'].map((v) => ({ label: v || 'Any provider', value: v }))"
        class="w-40"
      />
      <USelect
        v-model="taskType"
        :items="['', 'github_issue', 'gitlab_issue', 'github_pr_review', 'gitlab_mr_review', 'github_pr_implement', 'gitlab_mr_implement', 'release'].map((v) => ({ label: v || 'Any type', value: v }))"
        class="w-56"
      />
    </div>

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
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
          <tr v-for="run in data.items" :key="run.id" class="border-b border-[var(--aw-line)]">
            <td class="px-4 py-3">
              <NuxtLink :to="`/tasks/${run.id}`" class="font-medium hover:underline">
                {{ run.title || `#${run.externalId}` }}
              </NuxtLink>
              <a v-if="run.externalUrl" :href="run.externalUrl" target="_blank" class="ml-2 text-xs opacity-60 hover:underline">external</a>
            </td>
            <td class="px-4 py-3">{{ run.repositoryName || '—' }}</td>
            <td class="px-4 py-3">{{ run.taskType }}</td>
            <td class="px-4 py-3">{{ run.status }}</td>
            <td class="px-4 py-3">{{ run.provider || '—' }}</td>
            <td class="px-4 py-3">{{ fmtDuration(run.durationMs) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="flex justify-between px-4 py-3 text-sm opacity-70">
        <span>{{ data.total }} total</span>
        <div class="flex gap-2">
          <UButton size="xs" :disabled="page <= 1" @click="page--">Prev</UButton>
          <UButton size="xs" :disabled="page * data.pageSize >= data.total" @click="page++">Next</UButton>
        </div>
      </div>
    </div>
  </div>
</template>
