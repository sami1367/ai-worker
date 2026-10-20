<script setup lang="ts">
const { api } = useApi()
const { t } = useI18n()
const q = ref('')

const { data, pending } = await useAsyncData('create-tasks-repos', () =>
  api<{ items: Array<{
    id: string
    name: string
    forgeType: string
    canonicalProjectIdentifier: string | null
    workspaceStatus: string
    isEnabled: boolean
    isArchived: boolean
  }> }>('/api/v1/repositories?page=1&pageSize=100'),
)

const repos = computed(() => {
  const items = (data.value?.items || []).filter((r) => !r.isArchived)
  const needle = q.value.trim().toLowerCase()
  if (!needle) return items
  return items.filter((r) => {
    const hay = `${r.name} ${r.canonicalProjectIdentifier || ''} ${r.forgeType}`.toLowerCase()
    return hay.includes(needle)
  })
})

function forgeLabel(value?: string) {
  if (value === 'github') return 'GitHub'
  if (value === 'gitlab') return 'GitLab'
  return value || '—'
}

function workspaceTone(status?: string) {
  if (status === 'ready') return 'success'
  if (status === 'failed' || status === 'inaccessible') return 'error'
  if (status === 'cloning' || status === 'syncing' || status === 'queued') return 'warning'
  return 'neutral'
}
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">{{ t('createTasks.title') }}</h1>
      <p class="mt-1 max-w-2xl text-sm opacity-70">
        {{ t('createTasks.subtitle') }}
      </p>
    </div>

    <div class="aw-panel space-y-4 rounded-xl p-4">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="font-medium">{{ t('createTasks.selectRepo') }}</h2>
          <p class="text-sm opacity-70">{{ t('createTasks.selectRepoHint') }}</p>
        </div>
        <UInput
          v-model="q"
          :placeholder="t('createTasks.selectRepo')"
          icon="i-lucide-search"
          class="min-w-64"
        />
      </div>

      <div v-if="pending" class="py-8 text-center text-sm opacity-60">
        {{ t('createTasks.working') }}
      </div>
      <div v-else-if="!repos.length" class="py-8 text-center text-sm opacity-70">
        {{ t('createTasks.emptyRepos') }}
        <div class="mt-3">
          <UButton to="/repositories" variant="soft" icon="i-lucide-git-branch">
            {{ t('nav.repositories') }}
          </UButton>
        </div>
      </div>
      <ul v-else class="divide-y divide-[var(--aw-line)]">
        <li
          v-for="repo in repos"
          :key="repo.id"
          class="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <div class="min-w-0">
            <p class="truncate font-medium">{{ repo.name }}</p>
            <p class="truncate text-sm opacity-70">
              {{ forgeLabel(repo.forgeType) }}
              <span v-if="repo.canonicalProjectIdentifier"> · {{ repo.canonicalProjectIdentifier }}</span>
            </p>
            <div class="mt-1 flex flex-wrap gap-2">
              <UBadge :color="workspaceTone(repo.workspaceStatus)" variant="subtle" size="sm">
                {{ repo.workspaceStatus }}
              </UBadge>
              <UBadge :color="repo.isEnabled ? 'success' : 'neutral'" variant="subtle" size="sm">
                {{ repo.isEnabled ? 'enabled' : 'disabled' }}
              </UBadge>
            </div>
          </div>
          <UButton
            :to="`/create-tasks/${repo.id}`"
            icon="i-lucide-messages-square"
            color="primary"
          >
            {{ t('createTasks.openChat') }}
          </UButton>
        </li>
      </ul>
    </div>
  </div>
</template>
