<script setup lang="ts">
import type { MicroserviceGroupInput } from '#shared/microservices'
const { api } = useApi()
const busy = ref(false)
const error = ref('')
async function save(value: MicroserviceGroupInput) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await api<{ group: { id: string } }>('/api/v1/microservices/groups', { method: 'POST', body: value })
    await navigateTo(`/microservices/${result.group.id}`)
  } catch (e) {
    const err = e as { data?: { message?: string } }
    error.value = err.data?.message || 'Could not save group. Please try again.'
  } finally { busy.value = false }
}
</script>

<template>
  <div class="space-y-5 aw-fade-in">
    <UButton to="/microservices" variant="ghost" color="neutral" icon="i-lucide-arrow-left">All groups</UButton>
    <div><h1 class="font-display text-3xl">New project group</h1><p class="mt-2 text-sm opacity-70">Choose related projects and describe their roles. Each project gets its own folder inside the group workspace.</p></div>
    <UAlert v-if="error" color="error" :title="error" />
    <div class="aw-panel rounded-xl p-5"><MicroserviceGroupForm :busy="busy" @save="save" @cancel="navigateTo('/microservices')" /></div>
  </div>
</template>
