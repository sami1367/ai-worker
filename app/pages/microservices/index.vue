<script setup lang="ts">
const { api } = useApi()
const { data, error, refresh } = await useAsyncData('microservice-groups', () => api<{ items: Array<{
  id: string, name: string, description: string, projects: Array<{ labels: string[] }>, workspaceStatus: string
}> }>('/api/v1/microservices/groups'))
</script>

<template>
  <div class="space-y-6 aw-fade-in">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div><h1 class="font-display text-3xl">Microservices</h1><p class="mt-2 max-w-2xl text-sm opacity-70">Bring related projects together. Ask about the whole system, explore service relationships, and keep your conversations.</p></div>
      <UButton to="/microservices/new" icon="i-lucide-plus">New project group</UButton>
    </div>
    <UAlert v-if="error" color="error" title="Could not load your groups" :actions="[{ label: 'Retry', onClick: () => refresh() }]" />
    <div v-if="data && !data.items.length" class="aw-panel rounded-xl p-8 text-center">
      <UIcon name="i-lucide-network" class="mb-3 size-9 opacity-60" />
      <h2 class="font-medium">Your system, in one conversation</h2>
      <p class="mx-auto mt-2 max-w-lg text-sm opacity-70">Create a named group with two or more projects, label their roles, and start a chat with context from all of them.</p>
      <UButton to="/microservices/new" class="mt-4" variant="soft">Create your first group</UButton>
    </div>
    <div class="grid gap-4 md:grid-cols-2">
      <NuxtLink v-for="group in data?.items || []" :key="group.id" :to="`/microservices/${group.id}`" class="aw-panel space-y-3 rounded-xl p-5 transition hover:bg-black/5 dark:hover:bg-white/5">
        <div class="flex items-center justify-between gap-2"><h2 class="font-medium">{{ group.name }}</h2><UBadge :color="group.workspaceStatus === 'ready' ? 'success' : group.workspaceStatus === 'failed' ? 'error' : 'warning'" variant="subtle">{{ group.workspaceStatus }}</UBadge></div>
        <p class="line-clamp-2 text-sm opacity-70">{{ group.description || 'A connected group of projects' }}</p>
        <p class="text-xs opacity-60">{{ group.projects.length }} projects · Saved group chats</p>
        <div class="flex flex-wrap gap-1"><UBadge v-for="label in [...new Set(group.projects.flatMap(project => project.labels))].slice(0, 8)" :key="label" color="neutral" variant="subtle" size="sm">{{ label }}</UBadge></div>
      </NuxtLink>
    </div>
  </div>
</template>
