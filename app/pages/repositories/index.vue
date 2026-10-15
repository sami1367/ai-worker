<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const { api } = useApi()
const q = ref('')
const forgeType = ref<string>('')
const connectionId = ref<string>(typeof route.query.connectionId === 'string' ? route.query.connectionId : '')
const enabledFilter = ref<string>('')
const workspaceStatus = ref<string>('')
const page = ref(1)
const busy = ref('')
const togglingIds = ref(new Set<string>())
const message = ref('')
const messageError = ref(false)

function isToggling(id: string) {
  return togglingIds.value.has(id)
}

const { data: connectionsData } = await useAsyncData('connections-for-repo-filter', () =>
  api<{ items: Array<{
    id: string
    provider: string
    displayName: string | null
    accountLogin: string | null
    accountName: string | null
    status: string
  }> }>('/api/v1/connections'),
)

const connectionItems = computed(() => {
  const items = (connectionsData.value?.items || []).map((c) => {
    const account = c.accountLogin || c.accountName || c.displayName || c.id.slice(0, 8)
    const forge = c.provider === 'gitlab' ? 'GitLab' : c.provider === 'github' ? 'GitHub' : c.provider
    const status = c.status !== 'active' ? ` · ${c.status}` : ''
    return {
      label: `${forge}: ${account}${status}`,
      value: c.id,
    }
  })
  return [{ label: 'All connections', value: '' }, ...items]
})

const connectionLabelById = computed(() => {
  const map = new Map<string, string>()
  for (const c of connectionsData.value?.items || []) {
    const account = c.accountLogin || c.accountName || c.displayName || c.id.slice(0, 8)
    const forge = c.provider === 'gitlab' ? 'GitLab' : c.provider === 'github' ? 'GitHub' : c.provider
    map.set(c.id, `${forge}: ${account}`)
  }
  return map
})

const query = computed(() => {
  const p = new URLSearchParams()
  p.set('page', String(page.value))
  p.set('pageSize', '50')
  if (q.value) p.set('q', q.value)
  if (forgeType.value) p.set('forgeType', forgeType.value)
  if (connectionId.value) p.set('connectionId', connectionId.value)
  if (enabledFilter.value === 'true' || enabledFilter.value === 'false') {
    p.set('enabled', enabledFilter.value)
  }
  if (workspaceStatus.value) p.set('workspaceStatus', workspaceStatus.value)
  return p.toString()
})

const { data, pending, refresh } = await useAsyncData(
  'repos-managed',
  () => api<any>(`/api/v1/repositories?${query.value}`),
  { watch: [query] },
)

watch([q, forgeType, connectionId, enabledFilter, workspaceStatus], () => {
  page.value = 1
})

watch(connectionId, (id) => {
  const current = typeof route.query.connectionId === 'string' ? route.query.connectionId : ''
  if (current === id) return
  const next = { ...route.query } as Record<string, string | string[] | undefined>
  if (id) next.connectionId = id
  else delete next.connectionId
  void router.replace({ query: next })
})

watch(() => route.query.connectionId, (id) => {
  const next = typeof id === 'string' ? id : ''
  if (connectionId.value !== next) connectionId.value = next
})

function forgeLabel(value?: string | null) {
  if (value === 'github') return 'GitHub'
  if (value === 'gitlab') return 'GitLab'
  return value || '—'
}

function connectionLabel(id?: string | null) {
  if (!id) return '—'
  return connectionLabelById.value.get(id) || id.slice(0, 8)
}

function workspaceColor(status?: string) {
  if (status === 'ready') return 'success'
  if (status === 'failed' || status === 'inaccessible') return 'error'
  if (status === 'cloning' || status === 'syncing' || status === 'queued') return 'warning'
  return 'neutral'
}

async function setEnabled(repo: { id: string, name: string, isEnabled: boolean }, enabled: boolean) {
  if (repo.isEnabled === enabled || isToggling(repo.id)) return
  const next = new Set(togglingIds.value)
  next.add(repo.id)
  togglingIds.value = next
  // Optimistic update so the switch feels immediate — no top alert on toggle
  repo.isEnabled = enabled
  try {
    await api(`/api/v1/repositories/${repo.id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' })
  } catch {
    repo.isEnabled = !enabled
  } finally {
    const done = new Set(togglingIds.value)
    done.delete(repo.id)
    togglingIds.value = done
  }
}

function bulkFilterBody(enabled: boolean) {
  return {
    enabled,
    ...(connectionId.value ? { connectionId: connectionId.value } : {}),
    ...(forgeType.value === 'github' || forgeType.value === 'gitlab' ? { forgeType: forgeType.value } : {}),
    ...(q.value.trim() ? { q: q.value.trim() } : {}),
    ...(workspaceStatus.value ? { workspaceStatus: workspaceStatus.value } : {}),
  }
}

async function setAllEnabled(enabled: boolean) {
  const scope = [
    connectionId.value ? 'selected connection' : null,
    forgeType.value || null,
    q.value.trim() ? `search “${q.value.trim()}”` : null,
    workspaceStatus.value || null,
  ].filter(Boolean).join(', ')
  const label = enabled ? 'Enable' : 'Disable'
  const confirmMsg = scope
    ? `${label} all repositories matching current filters (${scope})?`
    : `${label} all managed repositories?`
  if (!confirm(confirmMsg)) return

  busy.value = enabled ? 'enable-all' : 'disable-all'
  try {
    await api<{ updated: number }>(
      '/api/v1/repositories/bulk-enabled',
      { method: 'POST', body: bulkFilterBody(enabled) },
    )
  } finally {
    await refresh()
    busy.value = ''
  }
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
          Disable a repo to stop forge polling until you turn it back on.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton variant="soft" icon="i-lucide-link" to="/connections">Connections</UButton>
        <UButton
          variant="soft"
          color="success"
          icon="i-lucide-check-check"
          :loading="busy === 'enable-all'"
          :disabled="Boolean(busy)"
          @click="setAllEnabled(true)"
        >
          Enable all
        </UButton>
        <UButton
          variant="soft"
          color="neutral"
          icon="i-lucide-ban"
          :loading="busy === 'disable-all'"
          :disabled="Boolean(busy)"
          @click="setAllEnabled(false)"
        >
          Disable all
        </UButton>
        <UButton
          :loading="busy === 'fetch'"
          icon="i-lucide-refresh-cw"
          :disabled="Boolean(busy) && busy !== 'fetch'"
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
        v-model="connectionId"
        :items="connectionItems"
        class="w-64"
        :placeholder="'All connections'"
      />
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
        v-model="enabledFilter"
        :items="[
          { label: 'Any status', value: '' },
          { label: 'Enabled only', value: 'true' },
          { label: 'Disabled only', value: 'false' },
        ]"
        class="w-44"
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
            <th class="px-4 py-3 font-medium">Connection</th>
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
              <p class="max-w-48 truncate text-sm">{{ connectionLabel(repo.connectionId) }}</p>
            </td>
            <td class="px-4 py-3">
              <UBadge :color="repo.forgeType === 'gitlab' ? 'warning' : 'info'" variant="subtle">
                {{ forgeLabel(repo.forgeType) }}
              </UBadge>
            </td>
            <td class="px-4 py-3">
              <USwitch
                :model-value="repo.isEnabled"
                :loading="isToggling(repo.id)"
                :disabled="isToggling(repo.id)"
                size="sm"
                :aria-label="repo.isEnabled ? `Disable ${repo.name}` : `Enable ${repo.name}`"
                @update:model-value="(v: boolean) => setEnabled(repo, v)"
              />
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
