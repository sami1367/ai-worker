<script setup lang="ts">
type PromptItem = {
  id: string
  path: string
  kind: 'template' | 'snippet'
  taskType: string | null
  displayName: string
  description: string | null
  contentVersion: number
  updatedAt: string
  content?: string
}

const { api } = useApi()
const { data, pending, refresh } = await useAsyncData('prompts', () =>
  api<{ items: PromptItem[] }>('/api/v1/prompts'),
)

const selectedId = ref<string | null>(null)
const draft = ref('')
const loadedContent = ref('')
const loadingDetail = ref(false)
const saving = ref(false)
const resetting = ref(false)
const message = ref('')
const messageError = ref(false)
const filter = ref<'all' | 'template' | 'snippet'>('all')

const items = computed(() => data.value?.items || [])
const filtered = computed(() => {
  if (filter.value === 'all') return items.value
  return items.value.filter((p) => p.kind === filter.value)
})
const selected = computed(() => items.value.find((p) => p.id === selectedId.value) || null)
const dirty = computed(() => selected.value != null && draft.value !== loadedContent.value)

function applyLoaded(full: PromptItem) {
  loadedContent.value = full.content || ''
  draft.value = loadedContent.value
  const idx = items.value.findIndex((x) => x.id === full.id)
  if (idx >= 0 && data.value) {
    data.value.items[idx] = { ...data.value.items[idx], ...full, content: undefined }
  }
}

async function selectPrompt(p: PromptItem) {
  if (dirty.value && !confirm('Discard unsaved changes?')) return
  selectedId.value = p.id
  message.value = ''
  messageError.value = false
  loadingDetail.value = true
  try {
    const full = await api<PromptItem>(`/api/v1/prompts/${p.id}`)
    applyLoaded(full)
  } catch (e: any) {
    message.value = e?.data?.message || 'Failed to load prompt'
    messageError.value = true
  } finally {
    loadingDetail.value = false
  }
}

async function save() {
  if (!selected.value) return
  saving.value = true
  message.value = ''
  messageError.value = false
  try {
    const updated = await api<PromptItem>(`/api/v1/prompts/${selected.value.id}`, {
      method: 'PATCH',
      body: { content: draft.value },
    })
    applyLoaded(updated)
    message.value = `Saved ${updated.displayName} (v${updated.contentVersion}). Next worker job will use this version.`
    await refresh()
    selectedId.value = updated.id
  } catch (e: any) {
    message.value = e?.data?.message || 'Save failed'
    messageError.value = true
  } finally {
    saving.value = false
  }
}

async function resetToSeed() {
  if (!selected.value) return
  if (!confirm(`Reset "${selected.value.displayName}" to the seeded file content?`)) return
  resetting.value = true
  message.value = ''
  messageError.value = false
  try {
    const updated = await api<PromptItem>(`/api/v1/prompts/${selected.value.id}/reset`, {
      method: 'POST',
    })
    applyLoaded(updated)
    message.value = `Reset ${updated.displayName} to seed (v${updated.contentVersion}).`
    await refresh()
    selectedId.value = updated.id
  } catch (e: any) {
    message.value = e?.data?.message || 'Reset failed'
    messageError.value = true
  } finally {
    resetting.value = false
  }
}

onMounted(async () => {
  if (items.value.length && !selectedId.value) {
    await selectPrompt(items.value[0])
  }
})
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">Prompts</h1>
      <p class="mt-1 text-sm opacity-70">
        System prompts seeded from <code class="text-xs">worker/prompts/</code>.
        Edits apply to the next job without restarting the worker.
      </p>
    </div>

    <UAlert
      v-if="message"
      :title="message"
      :color="messageError ? 'error' : 'success'"
      variant="subtle"
    />

    <div class="flex flex-wrap gap-2">
      <UButton
        size="sm"
        :variant="filter === 'all' ? 'solid' : 'ghost'"
        color="neutral"
        @click="filter = 'all'"
      >
        All ({{ items.length }})
      </UButton>
      <UButton
        size="sm"
        :variant="filter === 'template' ? 'solid' : 'ghost'"
        color="neutral"
        @click="filter = 'template'"
      >
        Templates
      </UButton>
      <UButton
        size="sm"
        :variant="filter === 'snippet' ? 'solid' : 'ghost'"
        color="neutral"
        @click="filter = 'snippet'"
      >
        Snippets
      </UButton>
    </div>

    <div v-if="pending && !items.length" class="aw-panel h-64 animate-pulse rounded-xl" />

    <div v-else class="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside class="aw-panel max-h-[70vh] space-y-1 overflow-y-auto rounded-xl p-2">
        <button
          v-for="p in filtered"
          :key="p.id"
          type="button"
          class="w-full rounded-lg px-3 py-2 text-left text-sm transition hover:bg-black/5 dark:hover:bg-white/5"
          :class="selectedId === p.id ? 'bg-black/5 font-medium dark:bg-white/10' : 'opacity-80'"
          @click="selectPrompt(p)"
        >
          <div class="truncate">{{ p.displayName }}</div>
          <div class="truncate text-xs opacity-60">{{ p.path }}</div>
        </button>
        <p v-if="!filtered.length" class="px-3 py-6 text-center text-sm opacity-60">No prompts</p>
      </aside>

      <section v-if="selected" class="aw-panel space-y-4 rounded-xl p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="font-display text-xl tracking-tight">{{ selected.displayName }}</h2>
            <p class="mt-1 text-sm opacity-70">{{ selected.description }}</p>
            <p class="mt-2 text-xs opacity-60">
              <code>{{ selected.path }}</code>
              · v{{ selected.contentVersion }}
              <span v-if="selected.taskType"> · {{ selected.taskType }}</span>
              · {{ selected.kind }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :loading="resetting"
              :disabled="saving || loadingDetail"
              @click="resetToSeed"
            >
              Reset to seed
            </UButton>
            <UButton
              :loading="saving"
              :disabled="!dirty || loadingDetail"
              @click="save"
            >
              Save
            </UButton>
          </div>
        </div>

        <div v-if="loadingDetail" class="h-96 animate-pulse rounded-lg bg-black/5 dark:bg-white/5" />
        <textarea
          v-else
          v-model="draft"
          class="min-h-[28rem] w-full rounded-lg border border-black/10 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-black/30 dark:border-white/10 dark:focus:border-white/30"
          spellcheck="false"
        />
        <p class="text-xs opacity-60">
          Use <code v-pre>{{INCLUDE:snippets/…}}</code> and <code v-pre>{{VAR}}</code> placeholders.
          Do not remove required placeholders unless runners are updated too.
        </p>
      </section>

      <section v-else class="aw-panel flex h-64 items-center justify-center rounded-xl text-sm opacity-60">
        Select a prompt to edit
      </section>
    </div>
  </div>
</template>
