<script setup lang="ts">
const { api } = useApi()
const q = ref('')
const forgeType = ref<string>('')
const enabled = ref<string>('')
const page = ref(1)

const query = computed(() => {
  const p = new URLSearchParams()
  p.set('page', String(page.value))
  p.set('pageSize', '20')
  if (q.value) p.set('q', q.value)
  if (forgeType.value) p.set('forgeType', forgeType.value)
  if (enabled.value) p.set('enabled', enabled.value)
  return p.toString()
})

const { data, pending, refresh } = await useAsyncData(
  'repos',
  () => api<any>(`/api/v1/repositories?${query.value}`),
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

async function toggle(repo: any, enable: boolean) {
  await api(`/api/v1/repositories/${repo.id}/${enable ? 'enable' : 'disable'}`, { method: 'POST' })
  await refresh()
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Repositories</h1>
        <p class="mt-1 text-sm opacity-70">
          Registered automation targets and workspace status.
          Prefer <NuxtLink to="/connections" class="underline">Connections</NuxtLink> for discovery and cloning.
        </p>
      </div>
      <div class="flex gap-2">
        <UButton variant="soft" icon="i-lucide-link" to="/connections">Connections</UButton>
        <UButton icon="i-lucide-plus" @click="showCreate = true">Manual add</UButton>
      </div>
    </div>

    <div class="aw-panel flex flex-wrap gap-3 rounded-xl p-4">
      <UInput v-model="q" placeholder="Search…" icon="i-lucide-search" class="min-w-56" />
      <USelect
        v-model="forgeType"
        :items="[{ label: 'All forges', value: '' }, { label: 'GitHub', value: 'github' }, { label: 'GitLab', value: 'gitlab' }]"
        class="w-40"
      />
      <USelect
        v-model="enabled"
        :items="[{ label: 'Any state', value: '' }, { label: 'Enabled', value: 'true' }, { label: 'Disabled', value: 'false' }]"
        class="w-40"
      />
    </div>

    <div v-if="pending && !data" class="aw-panel h-48 animate-pulse rounded-xl" />
    <div v-else-if="!data?.items?.length" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">
      No repositories yet. Add one to begin.
    </div>
    <div v-else class="aw-panel overflow-x-auto rounded-xl">
      <table class="min-w-full text-sm">
        <thead class="border-b border-[var(--aw-line)] text-left opacity-70">
          <tr>
            <th class="px-4 py-3 font-medium">Name</th>
            <th class="px-4 py-3 font-medium">Forge</th>
            <th class="px-4 py-3 font-medium">Workspace</th>
            <th class="px-4 py-3 font-medium">Enabled</th>
            <th class="px-4 py-3 font-medium">Health</th>
            <th class="px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="repo in data.items" :key="repo.id" class="border-b border-[var(--aw-line)] last:border-0">
            <td class="px-4 py-3">
              <NuxtLink :to="`/repositories/${repo.id}`" class="font-medium hover:underline">{{ repo.name }}</NuxtLink>
              <p class="max-w-xs truncate opacity-60">{{ repo.canonicalProjectIdentifier || repo.remoteUrl }}</p>
            </td>
            <td class="px-4 py-3">{{ repo.forgeType }}</td>
            <td class="px-4 py-3">
              <UBadge
                :color="repo.workspaceStatus === 'ready' ? 'success' : repo.workspaceStatus === 'failed' ? 'error' : 'warning'"
                variant="subtle"
              >
                {{ repo.workspaceStatus || 'unknown' }}
              </UBadge>
            </td>
            <td class="px-4 py-3">
              <UBadge :color="repo.isEnabled ? 'success' : 'neutral'" variant="subtle">
                {{ repo.isEnabled ? 'enabled' : 'disabled' }}
              </UBadge>
            </td>
            <td class="px-4 py-3">{{ repo.healthStatus }}</td>
            <td class="px-4 py-3">
              <div class="flex gap-2">
                <UButton size="xs" variant="soft" @click="toggle(repo, !repo.isEnabled)">
                  {{ repo.isEnabled ? 'Disable' : 'Enable' }}
                </UButton>
                <UButton size="xs" variant="ghost" :to="`/repositories/${repo.id}`">Open</UButton>
              </div>
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
