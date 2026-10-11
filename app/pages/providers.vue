<script setup lang="ts">
const { api } = useApi()
const { data, pending, refresh } = await useAsyncData('providers', () => api<any>('/api/v1/providers'))
const busy = ref('')
const message = ref('')

async function test(provider: string) {
  busy.value = provider
  message.value = ''
  try {
    await api(`/api/v1/providers/${provider}/test`, { method: 'POST' })
    message.value = `Health check completed for ${provider}`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Test failed'
  } finally {
    busy.value = ''
  }
}

async function save(p: any) {
  busy.value = `save-${p.providerType}`
  try {
    await api(`/api/v1/providers/${p.providerType}`, {
      method: 'PATCH',
      body: {
        isEnabled: p.isEnabled,
        isDefault: p.isDefault,
        config: p.config,
      },
    })
    message.value = `Saved ${p.providerType}`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Save failed'
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">AI providers</h1>
      <p class="mt-1 text-sm opacity-70">
        Binary presence can be checked safely. Authentication is never claimed from executable existence alone.
      </p>
    </div>
    <UAlert v-if="message" :title="message" />
    <div v-if="pending && !data" class="grid gap-4 md:grid-cols-2">
      <div v-for="i in 2" :key="i" class="aw-panel h-48 animate-pulse rounded-xl" />
    </div>
    <div v-else class="grid gap-4 md:grid-cols-2">
      <div v-for="p in data?.items || []" :key="p.id" class="aw-panel space-y-3 rounded-xl p-4">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h2 class="font-display text-xl">{{ p.displayName }}</h2>
            <p class="text-sm opacity-60">{{ p.providerType }}</p>
          </div>
          <UBadge :color="p.healthStatus === 'healthy' ? 'success' : p.healthStatus === 'degraded' ? 'warning' : 'neutral'" variant="subtle">
            {{ p.healthStatus }}
          </UBadge>
        </div>
        <p class="text-sm opacity-70">{{ p.healthMessage || 'No health check yet' }}</p>
        <p class="text-sm"><span class="opacity-60">Version:</span> {{ p.detectedVersion || 'unavailable' }}</p>
        <p class="text-sm"><span class="opacity-60">Secret configured:</span> {{ p.hasSecret ? 'yes' : 'no' }}</p>
        <UCheckbox v-model="p.isEnabled" label="Enabled" />
        <UCheckbox v-model="p.isDefault" label="Default provider" />
        <div class="flex gap-2">
          <UButton size="sm" :loading="busy === `save-${p.providerType}`" @click="save(p)">Save</UButton>
          <UButton size="sm" variant="soft" :loading="busy === p.providerType" @click="test(p.providerType)">
            Test provider
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
