<script setup lang="ts">
import { ACTIVE_WORK_STATUSES, type ChatWorkRunView } from '#shared/chat-work'
const { api } = useApi()
const items = ref<ChatWorkRunView[]>([])
const error = ref('')
type ChatProject = { id: string, name: string, forgeType: string, canonicalProjectIdentifier: string | null, isArchived: boolean }
type ChatGroup = { id: string, name: string, projects: unknown[] }
const projects = ref<ChatProject[]>([])
const groups = ref<ChatGroup[]>([])
const selectedProject = ref('')
const selectedGroup = ref('')
const projectsLoading = ref(true)
const groupsLoading = ref(true)
const projectsError = ref('')
const groupsError = ref('')
async function loadProjects() {
  projectsLoading.value = true
  projectsError.value = ''
  try {
    const loaded: ChatProject[] = []
    let page = 1
    while (true) {
      const result = await api<{ items: ChatProject[], total: number }>(`/api/v1/repositories?page=${page}&pageSize=100`)
      loaded.push(...result.items)
      if (loaded.length >= result.total || result.items.length < 100) break
      page++
    }
    projects.value = loaded.filter(project => !project.isArchived)
  } catch { projectsError.value = 'Could not load projects. Please retry.' } finally { projectsLoading.value = false }
}
async function loadGroups() {
  groupsLoading.value = true
  groupsError.value = ''
  try { groups.value = (await api<{ items: ChatGroup[] }>('/api/v1/microservices/groups')).items }
  catch { groupsError.value = 'Could not load groups. Please retry.' } finally { groupsLoading.value = false }
}
const activeOnly = ref(false)
const visible = computed(() => items.value.filter(run => !activeOnly.value || ACTIVE_WORK_STATUSES.includes(run.status)))
let timer: ReturnType<typeof setInterval> | null = null
async function refresh() {
  try { items.value = (await api<{ items: ChatWorkRunView[] }>('/api/v1/chat-work/runs')).items; error.value = '' } catch { error.value = 'Could not load chat work. Please retry.' }
}
onMounted(() => { void Promise.allSettled([refresh(), loadProjects(), loadGroups()]) })
onMounted(() => { timer = setInterval(() => { if (!document.hidden) void refresh() }, 5000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="space-y-5 aw-fade-in">
    <div><h1 class="font-display text-3xl">Chat work</h1><p class="mt-2 text-sm opacity-70">Approved work from your project and microservice chats. Runs continue in the background after you leave the chat.</p></div>
    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="start-chat-title">
      <div>
        <h2 id="start-chat-title" class="font-medium">Start a conversation</h2>
        <p class="mt-1 text-sm opacity-70">Choose a project or a group below. In the chat, switch to Work mode to generate tasks and approve implementation.</p>
      </div>
      <div class="grid gap-5 md:grid-cols-2">
        <div class="space-y-3">
          <label for="chat-work-project" class="block text-sm font-medium">Single project</label>
          <UAlert v-if="projectsError" color="error" :title="projectsError" :actions="[{ label: 'Retry', onClick: loadProjects }]" />
          <select id="chat-work-project" v-model="selectedProject" :disabled="projectsLoading || !projects.length" class="w-full rounded-lg border border-[var(--aw-line)] bg-[var(--aw-bg-0)] px-3 py-2 text-sm">
            <option value="" disabled>{{ projectsLoading ? 'Loading projects…' : 'Choose a project' }}</option>
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.canonicalProjectIdentifier || project.name }} · {{ project.forgeType === 'github' ? 'GitHub' : 'GitLab' }}</option>
          </select>
          <p v-if="!projectsLoading && !projectsError && !projects.length" class="text-sm opacity-65">No projects registered yet. Connect GitHub or GitLab and register a repository first.</p>
          <div class="flex flex-wrap gap-2">
            <UButton :to="selectedProject ? `/project-chat/${selectedProject}` : undefined" :disabled="!selectedProject || projectsLoading" icon="i-lucide-message-circle">Open project chat</UButton>
            <UButton to="/repositories" variant="ghost" color="neutral">Manage projects</UButton>
          </div>
        </div>
        <div class="space-y-3">
          <label for="chat-work-group" class="block text-sm font-medium">Microservice group</label>
          <UAlert v-if="groupsError" color="error" :title="groupsError" :actions="[{ label: 'Retry', onClick: loadGroups }]" />
          <select id="chat-work-group" v-model="selectedGroup" :disabled="groupsLoading || !groups.length" class="w-full rounded-lg border border-[var(--aw-line)] bg-[var(--aw-bg-0)] px-3 py-2 text-sm">
            <option value="" disabled>{{ groupsLoading ? 'Loading groups…' : 'Choose a group' }}</option>
            <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }} · {{ group.projects.length }} projects</option>
          </select>
          <p v-if="!groupsLoading && !groupsError && !groups.length" class="text-sm opacity-65">Create a group to chat and work across multiple projects.</p>
          <div class="flex flex-wrap gap-2">
            <UButton :to="selectedGroup ? `/microservices/${selectedGroup}` : undefined" :disabled="!selectedGroup || groupsLoading" icon="i-lucide-network">Open group chat</UButton>
            <UButton to="/microservices/new" variant="ghost" color="neutral" icon="i-lucide-plus">New group</UButton>
          </div>
        </div>
      </div>
    </section>
    <h2 class="font-medium">Approved work</h2>
    <UAlert v-if="error" color="error" :title="error" :actions="[{ label: 'Retry', onClick: refresh }]" />
    <label class="flex items-center gap-2 text-sm"><input v-model="activeOnly" type="checkbox">Show ongoing work only <UBadge variant="subtle">{{ items.filter(run => ACTIVE_WORK_STATUSES.includes(run.status)).length }}</UBadge></label>
    <div v-if="!visible.length && !error" class="aw-panel rounded-xl p-8 text-center text-sm opacity-70">{{ activeOnly ? 'No ongoing chat work.' : 'No approved work yet. Choose a project or group above to start your first conversation.' }}</div>
    <article v-for="run in visible" :key="run.id" class="aw-panel space-y-3 rounded-xl p-4">
      <div class="flex flex-wrap items-center justify-between gap-2"><NuxtLink :to="`/chat-work/${run.id}`" class="font-medium hover:underline">{{ run.title }}</NuxtLink><UBadge :color="run.status === 'succeeded' ? 'success' : ['failed', 'partial', 'interrupted'].includes(run.status) ? 'error' : 'neutral'" variant="subtle">{{ run.status }}</UBadge></div>
      <p class="text-xs opacity-60">{{ run.tasks.length }} tasks · {{ run.repositories.filter(repo => run.tasks.some(task => task.repositoryIds.includes(repo.id))).map(repo => repo.name).join(', ') }}</p>
      <p v-if="run.errorSummary" class="text-sm text-red-500">{{ run.errorSummary }}</p>
      <div class="flex flex-wrap gap-2"><UButton :to="`/chat-work/${run.id}`" size="sm" variant="soft">Progress & results</UButton><UButton :to="run.chatUrl" size="sm" variant="ghost" color="neutral" icon="i-lucide-message-circle">Open chat</UButton><UButton v-for="result in run.results.filter(result => result.url)" :key="result.repositoryId" :to="result.url" target="_blank" rel="noopener noreferrer" size="sm" variant="ghost" icon="i-lucide-git-pull-request">{{ result.name }}</UButton></div>
    </article>
  </div>
</template>
