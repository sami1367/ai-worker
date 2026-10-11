<script setup lang="ts">
const { api } = useApi()
const q = ref('')
const provider = ref<string>('')
const registered = ref<string>('')
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
  if (provider.value) p.set('provider', provider.value)
  if (registered.value) p.set('registered', registered.value)
  return p.toString()
})

const { data, pending, refresh } = await useAsyncData(
  'repos-discovered',
  () => api<any>(`/api/v1/discovered-repositories?${query.value}`),
  { watch: [query] },
)

const showCreate = ref(false)
const creating = ref(false)
const createError = ref('')
const form = reactive({
  name: '',
  forgeType: 'github' as 'github' | 'gitlab',
  remoteUrl: '',
  defaultBranch: 'main',
  blockOnOpenPr: true,
  activate: false,
  allowHostPath: false,
  localPath: '',
})

watch([q, provider, registered], () => {
  page.value = 1
  selected.value = []
})

function forgeLabel(value?: string | null) {
  if (value === 'github') return 'GitHub'
  if (value === 'gitlab') return 'GitLab'
  return value || '—'
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

async function createRepo() {
  createError.value = ''
  creating.value = true
  try {
    const body: any = { ...form }
    if (!body.allowHostPath) delete body.localPath
    const repo = await api<any>('/api/v1/repositories', { method: 'POST', body })
    showCreate.value = false
    await navigateTo(`/repositories/${repo.id}`)
  } catch (e: any) {
    createError.value = e?.data?.message || e?.statusMessage || 'Create failed'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Repositories</h1>
        <p class="mt-1 text-sm opacity-70">
          All repositories discovered from your
          <NuxtLink to="/connections" class="underline">Connections</NuxtLink>
          (GitHub and GitLab). Select repos to register for automation.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton variant="soft" icon="i-lucide-link" to="/connections">Connections</UButton>
        <UButton
          :disabled="!selected.length"
          :loading="busy === 'register'"
          icon="i-lucide-plus"
          @click="addSelected"
        >
          Add selected ({{ selected.length }})
        </UButton>
        <UButton variant="ghost" icon="i-lucide-plus" @click="showCreate = true">Manual add</UButton>
      </div>
    </div>

    <UAlert v-if="message" :color="messageError ? 'error' : 'success'" :title="message" variant="subtle" />

    <div class="aw-panel flex flex-wrap gap-3 rounded-xl p-4">
      <UInput v-model="q" placeholder="Search name, path, namespace…" icon="i-lucide-search" class="min-w-64" />
      <USelect
        v-model="provider"
        :items="[
          { label: 'All forges', value: '' },
          { label: 'GitHub', value: 'github' },
          { label: 'GitLab', value: 'gitlab' },
        ]"
        class="w-40"
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
      No repositories discovered yet.
      <NuxtLink to="/connections" class="underline">Connect GitHub or GitLab</NuxtLink>
      and refresh from the provider.
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
            <th class="px-4 py-3 font-medium">Select</th>
            <th class="px-4 py-3 font-medium">Repository</th>
            <th class="px-4 py-3 font-medium">Forge</th>
            <th class="px-4 py-3 font-medium">Connection</th>
            <th class="px-4 py-3 font-medium">Visibility</th>
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
            <td class="px-4 py-3">
              <UBadge :color="repo.provider === 'gitlab' ? 'warning' : 'info'" variant="subtle">
                {{ forgeLabel(repo.provider) }}
              </UBadge>
            </td>
            <td class="px-4 py-3">
              <NuxtLink
                v-if="repo.connectionId"
                :to="`/connections/${repo.connectionId}`"
                class="hover:underline"
              >
                {{ repo.connectionDisplayName || 'Connection' }}
              </NuxtLink>
              <span v-else>—</span>
            </td>
            <td class="px-4 py-3">{{ repo.visibility }}</td>
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

    <UModal v-model:open="showCreate" title="Add repository">
      <template #body>
        <form class="space-y-3" @submit.prevent="createRepo">
          <UFormField label="1. Forge" required>
            <USelect
              v-model="form.forgeType"
              :items="[{ label: 'GitHub', value: 'github' }, { label: 'GitLab', value: 'gitlab' }]"
            />
          </UFormField>
          <UFormField label="2. Name (matches docs / related services)" required>
            <UInput v-model="form.name" class="w-full" />
          </UFormField>
          <UFormField label="3. Remote URL" required>
            <UInput v-model="form.remoteUrl" placeholder="git@github.com:org/repo.git" class="w-full" />
          </UFormField>
          <UFormField label="Default branch">
            <UInput v-model="form.defaultBranch" class="w-full" />
          </UFormField>
          <UCheckbox v-model="form.blockOnOpenPr" label="Block new issues while open PR/MR exists" />
          <UCheckbox v-model="form.allowHostPath" label="Compatibility: use existing host path" />
          <UFormField v-if="form.allowHostPath" label="Absolute local path">
            <UInput v-model="form.localPath" class="w-full" />
          </UFormField>
          <UCheckbox v-model="form.activate" label="Activate automation after save" />
          <p class="text-xs opacity-60">
            Repositories save disabled unless you explicitly activate. Run a connection test and setup labels next.
          </p>
          <p v-if="createError" class="text-sm text-red-600">{{ createError }}</p>
          <UButton type="submit" :loading="creating" block>Save repository</UButton>
        </form>
      </template>
    </UModal>
  </div>
</template>
