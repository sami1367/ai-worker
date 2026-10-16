<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const id = computed(() => String(route.params.id))

const { data, pending, refresh } = await useAsyncData(
  () => `repo-${id.value}`,
  () => api<any>(`/api/v1/repositories/${id.value}`),
  { watch: [id] },
)

const { data: operations, refresh: refreshOps } = await useAsyncData(
  () => `repo-ops-${id.value}`,
  () => api<any>(`/api/v1/repositories/${id.value}/operations`),
  { watch: [id] },
)

const busy = ref('')
const message = ref('')
const messageError = ref(false)

async function action(path: string, label: string, body?: Record<string, unknown>) {
  busy.value = label
  message.value = ''
  messageError.value = false
  try {
    await api(`/api/v1/repositories/${id.value}/${path}`, { method: 'POST', body })
    message.value = `${label} completed`
    await Promise.all([refresh(), refreshOps(), refreshNuxtData('setup-readiness')])
  } catch (e: any) {
    message.value = e?.data?.message || e?.statusMessage || `${label} failed`
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

const acceptedReportersText = ref('')

function parseAcceptedReporters(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\n,]+/)) {
    const login = part.trim()
    if (!login) continue
    const key = login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(login)
  }
  return out
}

watch(() => data.value, (repo) => {
  if (!repo) return
  if (!repo.settings || typeof repo.settings !== 'object') {
    repo.settings = { customPrompt: '', acceptedReporters: [] }
  } else if (typeof repo.settings.customPrompt !== 'string') {
    repo.settings.customPrompt = ''
  }
  if (!Array.isArray(repo.settings.acceptedReporters)) {
    repo.settings.acceptedReporters = []
  }
  acceptedReportersText.value = (repo.settings.acceptedReporters as string[]).join('\n')
  if (typeof repo.forcePushToDefault !== 'boolean') {
    repo.forcePushToDefault = false
  }
  if (typeof repo.codegraphEnabled !== 'boolean') {
    repo.codegraphEnabled = true
  }
}, { immediate: true })

async function save() {
  if (!data.value) return
  busy.value = 'Saving'
  try {
    const acceptedReporters = parseAcceptedReporters(acceptedReportersText.value)
    await api(`/api/v1/repositories/${id.value}`, {
      method: 'PATCH',
      body: {
        remoteUrl: data.value.remoteUrl,
        defaultBranch: data.value.defaultBranch,
        blockOnOpenPr: data.value.blockOnOpenPr,
        forcePushToDefault: data.value.forcePushToDefault,
        codegraphEnabled: data.value.codegraphEnabled,
        defaultAiProvider: data.value.defaultAiProvider,
        settings: {
          customPrompt: data.value.settings?.customPrompt ?? '',
          acceptedReporters,
        },
      },
    })
    message.value = 'Saved (worker config will be re-exported for future tasks)'
    messageError.value = false
    await refresh()
  } catch (e: any) {
    message.value = e?.data?.message || 'Save failed'
    messageError.value = true
  } finally {
    busy.value = ''
  }
}

async function unregister(deleteWorkspace: boolean) {
  const msg = deleteWorkspace
    ? 'Remove this registration AND delete the managed workspace directory? This cannot be undone.'
    : 'Remove this registration? The workspace directory and forge connection will be kept.'
  if (!confirm(msg)) return
  await action('unregister', 'Unregister', { deleteWorkspace })
}

function workspaceColor(status: string) {
  if (status === 'ready') return 'success'
  if (status === 'failed' || status === 'inaccessible') return 'error'
  if (status === 'cloning' || status === 'syncing' || status === 'queued') return 'warning'
  return 'neutral'
}

// Poll while clone/sync is in progress
const stopPoll = ref<null | (() => void)>(null)
watch(() => data.value?.workspaceStatus, (status) => {
  stopPoll.value?.()
  stopPoll.value = null
  if (status && ['queued', 'cloning', 'syncing'].includes(status)) {
    const timer = setInterval(() => {
      void refresh()
      void refreshOps()
    }, 2500)
    stopPoll.value = () => clearInterval(timer)
  }
}, { immediate: true })

onBeforeUnmount(() => stopPoll.value?.())
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
          <p class="mt-1 text-sm opacity-70">
            {{ data.forgeType }} · {{ data.canonicalProjectIdentifier || data.remoteUrl }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton :loading="busy==='Clone'" variant="soft" @click="action('clone', 'Clone')">
            {{ data.workspaceStatus === 'failed' ? 'Retry clone' : 'Clone / repair' }}
          </UButton>
          <UButton :loading="busy==='Sync'" variant="soft" @click="action('sync', 'Sync')">Sync workspace</UButton>
          <UButton :loading="busy==='Test'" variant="soft" @click="action('test', 'Test')">Test</UButton>
          <UButton :loading="busy==='Labels'" variant="soft" @click="action('setup-labels', 'Labels')">Setup labels</UButton>
          <UButton :loading="busy==='Webhook'" variant="soft" @click="action('setup-webhook', 'Webhook')">Setup webhook</UButton>
          <UButton
            :loading="busy==='Enable' || busy==='Disable'"
            @click="action(data.isEnabled ? 'disable' : 'enable', data.isEnabled ? 'Disable' : 'Enable')"
          >
            {{ data.isEnabled ? 'Disable processing' : 'Enable processing' }}
          </UButton>
          <UButton color="error" variant="soft" :loading="busy==='Unregister'" @click="unregister(false)">
            Remove registration
          </UButton>
        </div>
      </div>

      <UAlert v-if="message" :title="message" :color="messageError ? 'error' : 'neutral'" />

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="aw-panel space-y-3 rounded-xl p-4">
          <h2 class="font-display text-xl">Configuration</h2>
          <UFormField label="Remote URL">
            <UInput v-model="data.remoteUrl" class="w-full" />
          </UFormField>
          <UFormField
            label="PR / MR target branch"
            hint="Branch that new pull requests and merge requests target (for example main, master, or develop). When force-push is enabled, changes are pushed directly to this branch instead. Also used when preparing the workspace checkout."
          >
            <UInput
              v-model="data.defaultBranch"
              class="w-full"
              placeholder="main"
              spellcheck="false"
            />
          </UFormField>
          <UFormField label="Default AI provider">
            <USelect
              v-model="data.defaultAiProvider"
              :items="[
                { label: 'cursor', value: 'cursor' },
                { label: 'claude', value: 'claude' },
                { label: 'codex', value: 'codex' },
                { label: 'gemini', value: 'gemini' },
                { label: 'copilot', value: 'copilot' },
              ]"
            />
          </UFormField>
          <UCheckbox v-model="data.blockOnOpenPr" label="Block new issues while an AI-labeled PR/MR is open" />
          <UCheckbox
            v-model="data.forcePushToDefault"
            label="Force-push to target branch (skip PR/MR)"
          />
          <p class="text-xs opacity-60">
            Off by default. When enabled, issue implement force-pushes commits onto the target branch above instead of opening a pull request or merge request. Overwrites that branch on the remote.
          </p>
          <UCheckbox
            v-model="data.codegraphEnabled"
            label="Enable CodeGraph (semantic code index)"
          />
          <p class="text-xs opacity-60">
            On by default for every repository. When enabled, the worker ensures a local <code class="text-[0.7rem]">.codegraph/</code> index exists before each agent run (<code class="text-[0.7rem]">codegraph init</code> if missing). When disabled, that directory is removed and not recreated until you turn this back on. The index is never committed.
          </p>
          <UFormField
            label="Repository prompt"
            hint="Optional. Appended to every AI task for this repo only. Global prompts still apply. Leave empty for none."
          >
            <textarea
              v-model="data.settings.customPrompt"
              rows="8"
              class="mt-1 w-full rounded-lg border border-black/10 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-black/30 dark:border-white/10 dark:focus:border-white/30"
              placeholder="e.g. Prefer existing service patterns in src/…; never change billing migrations without…"
              spellcheck="false"
            />
          </UFormField>
          <UFormField
            label="Accepted reporters"
            hint="Optional. GitHub logins or GitLab usernames allowed to open issues the system will work on. Leave empty to accept all members. One per line (or comma-separated). Issues must still be assigned to the connected forge account."
          >
            <textarea
              v-model="acceptedReportersText"
              rows="4"
              class="mt-1 w-full rounded-lg border border-black/10 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-black/30 dark:border-white/10 dark:focus:border-white/30"
              placeholder="alice&#10;bob"
              spellcheck="false"
            />
          </UFormField>
          <UButton :loading="busy==='Saving'" @click="save">Save changes</UButton>
        </div>

        <div class="aw-panel space-y-2 rounded-xl p-4 text-sm">
          <h2 class="font-display text-xl">Workspace status</h2>
          <p class="flex items-center gap-2">
            <span class="opacity-60">Status:</span>
            <UBadge :color="workspaceColor(data.workspaceStatus)" variant="subtle">
              {{ data.workspaceStatus }}
            </UBadge>
          </p>
          <p><span class="opacity-60">Enabled:</span> {{ data.isEnabled }}</p>
          <p><span class="opacity-60">Visibility:</span> {{ data.visibility || 'n/a' }}</p>
          <p><span class="opacity-60">Provider repo ID:</span> {{ data.providerRepoId || 'manual' }}</p>
          <p><span class="opacity-60">Instance:</span> {{ data.instanceUrl || 'n/a' }}</p>
          <p><span class="opacity-60">Workspace ID:</span> {{ data.workspaceId }}</p>
          <p><span class="opacity-60">Local path:</span> {{ data.localPath || 'unavailable' }}</p>
          <p><span class="opacity-60">Last clone:</span> {{ data.lastCloneAt || 'never' }}</p>
          <p><span class="opacity-60">Last sync:</span> {{ data.lastSyncAt || 'never' }}</p>
          <p><span class="opacity-60">Health:</span> {{ data.healthStatus }} — {{ data.healthMessage || 'n/a' }}</p>
          <p v-if="data.lastError" class="text-red-700 dark:text-red-300">{{ data.lastError }}</p>
          <div class="pt-2">
            <UButton size="xs" color="error" variant="ghost" @click="unregister(true)">
              Delete managed workspace…
            </UButton>
          </div>
        </div>
      </div>

      <div class="aw-panel rounded-xl p-4">
        <h2 class="font-display text-xl">Workspace operations</h2>
        <div v-if="!operations?.items?.length" class="mt-3 text-sm opacity-60">No clone/sync operations yet.</div>
        <ul v-else class="mt-3 divide-y divide-[var(--aw-line)]">
          <li v-for="op in operations.items" :key="op.id" class="py-2 text-sm">
            <div class="flex justify-between gap-3">
              <span>{{ op.operationType }} · {{ op.status }}</span>
              <span class="opacity-60">{{ op.createdAt }}</span>
            </div>
            <p v-if="op.errorSummary" class="text-xs text-red-700 dark:text-red-300">{{ op.errorSummary }}</p>
            <pre v-if="op.logExcerpt" class="mt-1 max-h-24 overflow-auto text-xs opacity-60">{{ op.logExcerpt }}</pre>
          </li>
        </ul>
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
