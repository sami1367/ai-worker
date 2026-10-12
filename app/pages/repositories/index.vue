<script setup lang="ts">
const { api } = useApi()
const q = ref('')
const forgeType = ref<string>('')
const workspaceStatus = ref<string>('')
const page = ref(1)
const busy = ref('')
const message = ref('')
const messageError = ref(false)

const query = computed(() => {
  const p = new URLSearchParams()
  p.set('page', String(page.value))
  p.set('pageSize', '50')
  if (q.value) p.set('q', q.value)
  if (forgeType.value) p.set('forgeType', forgeType.value)
  if (workspaceStatus.value) p.set('workspaceStatus', workspaceStatus.value)
  return p.toString()
})

const { data, pending, refresh } = await useAsyncData(
  'repos-managed',
  () => api<any>(`/api/v1/repositories?${query.value}`),
  { watch: [query] },
)

watch([q, forgeType, workspaceStatus], () => {
  page.value = 1
})

function forgeLabel(value?: string | null) {
  if (value === 'github') return 'GitHub'
  if (value === 'gitlab') return 'GitLab'
  return value || '—'
}

function workspaceColor(status?: string) {
  if (status === 'ready') return 'success'
  if (status === 'failed' || status === 'inaccessible') return 'error'
  if (status === 'cloning' || status === 'syncing' || status === 'queued') return 'warning'
  return 'neutral'
}

async function fetchAll() {
  busy.value = 'fetch'
  message.value = ''
  try {
    const res = await api<any>('/api/v1/discovered-repositories/fetch-all', { method: 'POST' })
    if (res.skipped) {
      message.value = 'A fetch is already running. Try again in a moment.'
      messageError.value = false
    } else {
      message.value = `Fetched ${res.discovered || 0} repos from ${res.connections || 0} connection(s); registered ${res.registeredNew || 0} new.`
      messageError.value = false
    }
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Fetch failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Repositories</h1>
        <p class="mt-1 text-sm opacity-70">
          Managed automatically from your
          <NuxtLink to="/connections" class="underline">Connections</NuxtLink>.
          Clones happen only when an AI job needs the workspace.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton variant="soft" icon="i-lucide-link" to="/connections">Connections</UButton>
        <UButton
          :loading="busy === 'fetch'"
          icon="i-lucide-refresh-cw"
          @click="fetchAll"
        >
          Fetch new repos
        </UButton>
      </div>
    </div>

    <UAlert v-if="message" :color="messageError ? 'error' : 'success'" :title="message" variant="subtle" />

    <div class="aw-panel flex flex-wrap gap-3 rounded-xl p-4">
      <UInput v-model="q" placeholder="Search name, path…" icon="i-lucide-search" class="min-w-64" />
      <USelect
        v-model="forgeType"
        :items="[
          { label: 'All forges', value: '' },
          { label: 'GitHub', value: 'github' },
          { label: 'GitLab', value: 'gitlab' },
        ]"
        class="w-40"
      />
      <USelect
        v-model="workspaceStatus"
        :items="[
          { label: 'Any workspace', value: '' },
          { label: 'Not cloned', value: 'not_cloned' },
          { label: 'Ready', value: 'ready' },
          { label: 'Queued / cloning', value: 'queued' },
          { label: 'Failed', value: 'failed' },
        ]"
        class="w-48"
      />
    </div>

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No managed repositories yet.
      <NuxtLink to="/connections" class="underline">Connect GitHub or GitLab</NuxtLink>
      — repos are registered automatically (no clone until needed).
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
            <th class="px-4 py-3 font-medium">Repository</th>
            <th class="px-4 py-3 font-medium">Forge</th>
            <th class="px-4 py-3 font-medium">Enabled</th>
            <th class="px-4 py-3 font-medium">Workspace</th>
            <th class="px-4 py-3 font-medium" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="repo in data.items"
            :key="repo.id"
            class="border-b border-[var(--aw-line)] last:border-0"
          >
            <td class="px-4 py-3">
              <p class="font-medium">{{ repo.canonicalProjectIdentifier || repo.name }}</p>
              <p class="max-w-md truncate text-xs opacity-60">{{ repo.remoteUrl }}</p>
            </td>
            <td class="px-4 py-3">
              <UBadge :color="repo.forgeType === 'gitlab' ? 'warning' : 'info'" variant="subtle">
                {{ forgeLabel(repo.forgeType) }}
              </UBadge>
            </td>
            <td class="px-4 py-3">
              <UBadge :color="repo.isEnabled ? 'success' : 'neutral'" variant="subtle">
                {{ repo.isEnabled ? 'on' : 'off' }}
              </UBadge>
            </td>
            <td class="px-4 py-3">
              <UBadge :color="workspaceColor(repo.workspaceStatus)" variant="subtle">
                {{ repo.workspaceStatus }}
              </UBadge>
            </td>
            <td class="px-4 py-3 text-right">
              <NuxtLink :to="`/repositories/${repo.id}`" class="text-xs underline opacity-70">
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
