<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const id = computed(() => String(route.params.id))

const q = ref('')
const visibility = ref('')
const registered = ref('')
const page = ref(1)
const selected = ref<string[]>([])
const busy = ref('')
const message = ref('')
const messageError = ref(false)

const query = computed(() => {
  const p = new URLSearchParams()
  p.set('page', String(page.value))
  p.set('pageSize', '50')
  if (q.value) p.set('q', q.value)
  if (visibility.value) p.set('visibility', visibility.value)
  if (registered.value) p.set('registered', registered.value)
  return p.toString()
})

const { data: connection, refresh: refreshConnection } = await useAsyncData(
  () => `connection-${id.value}`,
  () => api<any>(`/api/v1/connections/${id.value}`),
  { watch: [id] },
)

const { data, pending, refresh } = await useAsyncData(
  () => `discovered-${id.value}-${query.value}`,
  () => api<any>(`/api/v1/connections/${id.value}/repositories?${query.value}`),
  { watch: [query, id] },
)

async function refreshList() {
  busy.value = 'refresh'
  message.value = ''
  try {
    const res = await api<{ count: number }>(`/api/v1/connections/${id.value}/refresh`, { method: 'POST' })
    message.value = `Synced ${res.count} repositories`
    messageError.value = false
    selected.value = []
    await Promise.all([refresh(), refreshConnection()])
  } catch (e: any) {
    message.value = e?.data?.message || 'Refresh failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

function toggle(repoId: string, isRegistered: boolean) {
  if (isRegistered) return
  if (selected.value.includes(repoId)) {
    selected.value = selected.value.filter((x) => x !== repoId)
  } else {
    selected.value = [...selected.value, repoId]
  }
}

function selectVisible() {
  const ids = (data.value?.items || [])
    .filter((r: any) => !r.isRegistered)
    .map((r: any) => r.id)
  selected.value = Array.from(new Set([...selected.value, ...ids]))
}

async function addSelected() {
  if (!selected.value.length) return
  busy.value = 'register'
  message.value = ''
  try {
    const res = await api<any>('/api/v1/discovered-repositories/register', {
      method: 'POST',
      body: { discoveredRepositoryIds: selected.value, enable: false },
    })
    const created = res.created?.length || 0
    const skipped = res.skipped?.length || 0
    message.value = `Registered ${created} repositories${skipped ? `, skipped ${skipped}` : ''}. Clones queued.`
    messageError.value = false
    selected.value = []
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Registration failed'
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
        <NuxtLink to="/connections" class="text-sm opacity-60 hover:underline">← Connections</NuxtLink>
        <h1 class="font-display text-3xl tracking-tight">
          {{ connection?.displayName || connection?.accountLogin || 'Repository discovery' }}
        </h1>
        <p class="mt-1 text-sm opacity-70">
          {{ connection?.provider }} · {{ connection?.instanceUrl }} · last sync
          {{ connection?.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleString() : 'never' }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton variant="soft" :loading="busy === 'refresh'" icon="i-lucide-refresh-cw" @click="refreshList">
          Refresh from provider
        </UButton>
        <UButton
          :disabled="!selected.length"
          :loading="busy === 'register'"
          icon="i-lucide-plus"
          @click="addSelected"
        >
          Add selected ({{ selected.length }})
        </UButton>
      </div>
    </div>

    <UAlert v-if="message" :color="messageError ? 'error' : 'success'" :title="message" variant="subtle" />

    <div class="aw-panel flex flex-wrap gap-3 rounded-xl p-4">
      <UInput v-model="q" placeholder="Search name, path, namespace…" icon="i-lucide-search" class="min-w-64" />
      <USelect
        v-model="visibility"
        :items="[
          { label: 'Any visibility', value: '' },
          { label: 'Public', value: 'public' },
          { label: 'Private', value: 'private' },
          { label: 'Internal', value: 'internal' },
        ]"
        class="w-44"
      />
      <USelect
        v-model="registered"
        :items="[
          { label: 'All', value: '' },
          { label: 'Not registered', value: 'false' },
          { label: 'Already registered', value: 'true' },
        ]"
        class="w-48"
      />
      <UButton size="sm" variant="ghost" @click="selectVisible">Select visible</UButton>
      <UButton size="sm" variant="ghost" @click="selected = []">Clear selection</UButton>
    </div>

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No repositories discovered yet. Refresh from the provider, or reconnect if the connection has errors.
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
            <th class="px-4 py-3 font-medium">Select</th>
            <th class="px-4 py-3 font-medium">Repository</th>
            <th class="px-4 py-3 font-medium">Visibility</th>
            <th class="px-4 py-3 font-medium">Default branch</th>
            <th class="px-4 py-3 font-medium">Access</th>
            <th class="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="repo in data.items"
            :key="repo.id"
            class="border-b border-[var(--aw-line)] last:border-0"
            :class="repo.isRegistered ? 'opacity-70' : ''"
          >
            <td class="px-4 py-3">
              <input
                type="checkbox"
                :disabled="repo.isRegistered"
                :checked="selected.includes(repo.id)"
                @change="toggle(repo.id, repo.isRegistered)"
              >
            </td>
            <td class="px-4 py-3">
              <p class="font-medium">{{ repo.fullName }}</p>
              <p class="max-w-md truncate text-xs opacity-60">{{ repo.cloneUrlHttps }}</p>
            </td>
            <td class="px-4 py-3">{{ repo.visibility }}</td>
            <td class="px-4 py-3">{{ repo.defaultBranch }}</td>
            <td class="px-4 py-3 text-xs opacity-70">
              <span v-if="repo.permissions?.push">push</span>
              <span v-else-if="repo.permissions?.pull">pull</span>
              <span v-else-if="repo.permissions?.accessLevel">level {{ repo.permissions.accessLevel }}</span>
              <span v-else>—</span>
            </td>
            <td class="px-4 py-3">
              <UBadge v-if="repo.isRegistered" color="success" variant="subtle">registered</UBadge>
              <UBadge v-else color="neutral" variant="subtle">discovered</UBadge>
              <NuxtLink
                v-if="repo.registeredRepositoryId"
                :to="`/repositories/${repo.registeredRepositoryId}`"
                class="ml-2 text-xs underline opacity-70"
              >
                open
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
