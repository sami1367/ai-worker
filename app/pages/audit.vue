<script setup lang="ts">
const { api } = useApi()
const page = ref(1)
const { data, pending } = await useAsyncData(
  'audit',
  () => api<any>(`/api/v1/audit-logs?page=${page.value}&pageSize=50`),
  { watch: [page] },
)
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">Audit log</h1>
      <p class="mt-1 text-sm opacity-70">Security-sensitive administrative actions</p>
    </div>

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No audit events yet.
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
            <th class="px-4 py-3">When</th>
            <th class="px-4 py-3">Actor</th>
            <th class="px-4 py-3">Action</th>
            <th class="px-4 py-3">Target</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in data.items" :key="row.id" class="border-b border-[var(--aw-line)]">
            <td class="px-4 py-3 whitespace-nowrap">{{ row.createdAt }}</td>
            <td class="px-4 py-3">{{ row.actorUsername || '—' }}</td>
            <td class="px-4 py-3">{{ row.action }}</td>
            <td class="px-4 py-3">{{ row.targetType || '—' }} {{ row.targetId || '' }}</td>
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
