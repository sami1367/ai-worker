<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const id = computed(() => String(route.params.id))

const { data, pending, refresh } = await useAsyncData(
  () => `repo-${id.value}`,
  () => api<any>(`/api/v1/repositories/${id.value}`),
  { watch: [id] },
)

const busy = ref('')
const message = ref('')

async function action(path: string, label: string) {
  busy.value = label
  message.value = ''
  try {
    await api(`/api/v1/repositories/${id.value}/${path}`, { method: 'POST' })
    message.value = `${label} completed`
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || e?.statusMessage || `${label} failed`
  } finally {
    busy.value = ''
  }
}

async function save() {
  if (!data.value) return
  busy.value = 'Saving'
  try {
    await api(`/api/v1/repositories/${id.value}`, {
      method: 'PATCH',
      body: {
        remoteUrl: data.value.remoteUrl,
        defaultBranch: data.value.defaultBranch,
        blockOnOpenPr: data.value.blockOnOpenPr,
        defaultAiProvider: data.value.defaultAiProvider,
      },
    })
    message.value = 'Saved (worker config will be re-exported for future tasks)'
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
    <div v-if="pending && !data" class="aw-panel h-40 animate-pulse rounded-xl" />
    <template v-else-if="data">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-sm opacity-60">
            <NuxtLink to="/repositories" class="hover:underline">Repositories</NuxtLink>
          </p>
          <h1 class="font-display text-3xl tracking-tight">{{ data.name }}</h1>
          <p class="mt-1 text-sm opacity-70">{{ data.forgeType }} · {{ data.remoteUrl }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton :loading="busy==='Test'" variant="soft" @click="action('test', 'Test')">Test connection</UButton>
          <UButton :loading="busy==='Labels'" variant="soft" @click="action('setup-labels', 'Labels')">Setup labels</UButton>
          <UButton
            :loading="busy==='Enable' || busy==='Disable'"
            @click="action(data.isEnabled ? 'disable' : 'enable', data.isEnabled ? 'Disable' : 'Enable')"
          >
            {{ data.isEnabled ? 'Disable' : 'Enable' }}
          </UButton>
          <UButton color="error" variant="soft" :loading="busy==='Archive'" @click="action('archive', 'Archive')">
            Archive
          </UButton>
        </div>
      </div>

      <UAlert v-if="message" :title="message" color="neutral" />

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="aw-panel space-y-3 rounded-xl p-4">
          <h2 class="font-display text-xl">Configuration</h2>
          <UFormField label="Remote URL">
            <UInput v-model="data.remoteUrl" class="w-full" />
          </UFormField>
          <UFormField label="Default branch">
            <UInput v-model="data.defaultBranch" class="w-full" />
          </UFormField>
          <UFormField label="Default AI provider">
            <USelect
              v-model="data.defaultAiProvider"
              :items="[{ label: 'cursor', value: 'cursor' }, { label: 'claude', value: 'claude' }]"
            />
          </UFormField>
          <UCheckbox v-model="data.blockOnOpenPr" label="Block new issues while open PR/MR exists" />
          <UButton :loading="busy==='Saving'" @click="save">Save changes</UButton>
        </div>

        <div class="aw-panel space-y-2 rounded-xl p-4 text-sm">
          <h2 class="font-display text-xl">Status</h2>
          <p><span class="opacity-60">Enabled:</span> {{ data.isEnabled }}</p>
          <p><span class="opacity-60">Workspace ID:</span> {{ data.workspaceId }}</p>
          <p><span class="opacity-60">Local path:</span> {{ data.localPath || 'unavailable' }}</p>
          <p><span class="opacity-60">Health:</span> {{ data.healthStatus }} — {{ data.healthMessage || 'n/a' }}</p>
          <p><span class="opacity-60">Last check:</span> {{ data.lastHealthCheckAt || 'never' }}</p>
        </div>
      </div>

      <div class="aw-panel rounded-xl p-4">
        <h2 class="font-display text-xl">Recent task history</h2>
        <div v-if="!data.recentRuns?.length" class="mt-3 text-sm opacity-60">No runs for this repository.</div>
        <ul v-else class="mt-3 divide-y divide-[var(--aw-line)]">
          <li v-for="run in data.recentRuns" :key="run.id" class="flex justify-between py-2 text-sm">
            <NuxtLink :to="`/tasks/${run.id}`" class="hover:underline">
              {{ run.title || `${run.taskType} #${run.externalId}` }}
            </NuxtLink>
            <span class="opacity-60">{{ run.status }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
