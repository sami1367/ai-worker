<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const id = computed(() => String(route.params.id))

const q = ref('')
const visibility = ref('')
const page = ref(1)
const busy = ref('')
const message = ref('')
const messageError = ref(false)

const query = computed(() => {
  const p = new URLSearchParams()
  p.set('page', String(page.value))
  p.set('pageSize', '50')
  if (q.value) p.set('q', q.value)
  if (visibility.value) p.set('visibility', visibility.value)
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

watch([q, visibility], () => {
  page.value = 1
})

async function refreshList() {
  busy.value = 'refresh'
  message.value = ''
  try {
    const res = await api<{
      count: number
      publicCount?: number
      privateCount?: number
      registeredNew?: number
      accessWarning?: string | null
    }>(
      `/api/v1/connections/${id.value}/refresh`,
      { method: 'POST' },
    )
    const pub = res.publicCount ?? '?'
    const priv = res.privateCount ?? '?'
    const added = res.registeredNew ?? 0
    message.value = res.accessWarning
      || `Synced ${res.count} repositories (${pub} public, ${priv} private); registered ${added} new`
    messageError.value = Boolean(res.accessWarning)
    await Promise.all([refresh(), refreshConnection()])
  } catch (e: any) {
    message.value = e?.data?.message || 'Refresh failed'
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
        <p class="mt-1 text-xs opacity-50">
          Repos are registered automatically. Workspaces clone only when an AI job needs them.
        </p>
        <p v-if="connection?.scopes" class="mt-1 text-xs opacity-50">
          Token scopes: {{ connection.scopes }}
        </p>
        <UAlert
          v-if="connection?.lastError"
          class="mt-3"
          color="warning"
          variant="subtle"
          :title="connection.lastError"
        />
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton variant="soft" to="/repositories" icon="i-lucide-folder-git-2">
          All repositories
        </UButton>
        <UButton :loading="busy === 'refresh'" icon="i-lucide-refresh-cw" @click="refreshList">
          Fetch from provider
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
    </div>

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No repositories discovered yet. Fetch from the provider, or reconnect if the connection has errors.
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
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
          >
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
              <UBadge v-if="repo.isRegistered" color="success" variant="subtle">managed</UBadge>
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
