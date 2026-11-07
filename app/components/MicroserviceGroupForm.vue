<script setup lang="ts">
import { SERVICE_LABELS, microserviceGroupSchema, type MicroserviceGroupInput } from '#shared/microservices'
const props = defineProps<{ initial?: MicroserviceGroupInput, busy?: boolean }>()
const emit = defineEmits<{ save: [value: MicroserviceGroupInput], cancel: [] }>()
const { api } = useApi()
type Repository = { id: string, name: string, forgeType: string, canonicalProjectIdentifier: string | null }
const repositories = ref<Repository[]>([])
const name = ref(props.initial?.name || '')
const description = ref(props.initial?.description || '')
const codegraphEnabled = ref(props.initial?.codegraphEnabled ?? true)
const projects = ref((props.initial?.projects || []).map(project => ({ ...project, labels: [...project.labels] })))
const labelInputs = ref<Record<string, string>>(Object.fromEntries(projects.value.map(project => [project.repositoryId, project.labels.join(', ')])))
const search = ref('')
const error = ref('')
const loading = ref(true)
const visible = computed(() => repositories.value.filter(repo => `${repo.name} ${repo.canonicalProjectIdentifier || ''}`.toLowerCase().includes(search.value.toLowerCase())))
async function loadRepositories() {
  loading.value = true
  error.value = ''
  try {
    const items: Repository[] = []
    let page = 1
    while (true) {
      const result = await api<{ items: Repository[], total: number }>(`/api/v1/repositories?page=${page}&pageSize=100`)
      items.push(...result.items)
      if (items.length >= result.total || !result.items.length) break
      page++
    }
    repositories.value = items
  } catch { error.value = 'Could not load projects. Please retry.' } finally { loading.value = false }
}
function select(id: string, checked: boolean) {
  if (checked && !projects.value.some(project => project.repositoryId === id)) projects.value.push({ repositoryId: id, labels: [], description: '' })
  else if (!checked) projects.value = projects.value.filter(project => project.repositoryId !== id)
}
function toggleLabel(project: MicroserviceGroupInput['projects'][number], label: string) {
  if (project.labels.includes(label)) project.labels = project.labels.filter(value => value !== label)
  else if (project.labels.length < 15) project.labels.push(label)
  labelInputs.value[project.repositoryId] = project.labels.join(', ')
}
function submit() {
  const parsed = microserviceGroupSchema.safeParse({ name: name.value, description: description.value, codegraphEnabled: codegraphEnabled.value, projects: projects.value })
  if (!parsed.success) { error.value = parsed.error.issues[0]?.message || 'Check the group details'; return }
  error.value = ''
  emit('save', parsed.data)
}
await loadRepositories()
</script>

<template>
  <form class="space-y-5" @submit.prevent="submit">
    <UAlert v-if="error" color="error" :title="error" />
    <div class="grid gap-4 md:grid-cols-2">
      <label class="space-y-1 text-sm"><span class="block font-medium">Group name</span><UInput v-model="name" placeholder="For example, Avat platform" class="w-full" :maxlength="100" required :disabled="busy" /></label>
      <label class="space-y-1 text-sm"><span class="block font-medium">What does this system do?</span><UTextarea v-model="description" placeholder="A short description to help the AI understand the system" class="w-full" :rows="2" :maxlength="2000" :disabled="busy" /></label>
    </div>
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-medium">Select projects <span class="text-sm opacity-60">({{ projects.length }}/20; minimum 2)</span></h2>
        <UInput v-model="search" aria-label="Search projects" placeholder="Search projects…" icon="i-lucide-search" />
      </div>
      <p v-if="loading" class="text-sm opacity-60">Loading projects…</p>
      <div class="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-[var(--aw-line)] p-3">
        <label v-for="repo in visible" :key="repo.id" class="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/5">
          <input type="checkbox" class="mt-1" :checked="projects.some(project => project.repositoryId === repo.id)" :disabled="busy || (projects.length >= 20 && !projects.some(project => project.repositoryId === repo.id))" @change="select(repo.id, ($event.target as HTMLInputElement).checked)">
          <span><span class="block text-sm font-medium">{{ repo.name }}</span><span class="text-xs opacity-60">{{ repo.forgeType }} · {{ repo.canonicalProjectIdentifier }}</span></span>
        </label>
        <p v-if="!loading && !visible.length" class="text-sm opacity-60">No matching projects. Register projects on the Repositories page first.</p>
      </div>
      <UButton v-if="error && !repositories.length" variant="soft" @click="loadRepositories">Retry loading projects</UButton>
    </div>
    <div v-for="project in projects" :key="project.repositoryId" class="space-y-3 rounded-xl border border-[var(--aw-line)] p-4">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-medium">{{ repositories.find(repo => repo.id === project.repositoryId)?.name || 'Unavailable project' }}</h3>
        <UButton size="xs" variant="ghost" color="neutral" :disabled="busy" @click="select(project.repositoryId, false)">Remove</UButton>
      </div>
      <p class="text-xs opacity-60">Choose labels that describe this project's role.</p>
      <div class="flex flex-wrap gap-2">
        <button v-for="label in SERVICE_LABELS" :key="label" type="button" class="rounded-full border px-2.5 py-1 text-xs" :class="project.labels.includes(label) ? 'border-[var(--aw-accent)] bg-[color-mix(in_oklab,var(--aw-accent)_15%,transparent)]' : 'border-[var(--aw-line)] opacity-70'" :aria-pressed="project.labels.includes(label)" :disabled="busy" @click="toggleLabel(project, label)">{{ label }}</button>
      </div>
      <label class="block space-y-1 text-sm"><span class="block text-xs opacity-60">Labels, including custom ones (comma separated)</span><UInput v-model="labelInputs[project.repositoryId]" class="w-full" placeholder="backend, API, billing" :disabled="busy" @update:model-value="value => project.labels = String(value).split(',').map(label => label.trim()).filter(Boolean)" /></label>
      <label class="block space-y-1 text-sm"><span class="block text-xs opacity-60">Describe responsibilities or relationships</span><UTextarea v-model="project.description" class="w-full" placeholder="For example, public API; sends billing events to subscription" :rows="2" :maxlength="1000" :disabled="busy" /></label>
    </div>
    <label class="flex items-start gap-2 text-sm"><input v-model="codegraphEnabled" type="checkbox" class="mt-1" :disabled="busy"><span>Build a CodeGraph index across this group's repositories<span class="block text-xs opacity-60">This group has its own index. Repository worker settings stay separate.</span></span></label>
    <div class="flex gap-2">
      <UButton type="submit" :loading="busy" :disabled="busy || loading || projects.length < 2">Save group & prepare workspace</UButton>
      <UButton variant="ghost" color="neutral" :disabled="busy" @click="emit('cancel')">Cancel</UButton>
    </div>
  </form>
</template>
