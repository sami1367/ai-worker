<script setup lang="ts">
const route = useRoute()
const colorMode = useColorMode()
const { api } = useApi()

const links = [
  { to: '/', label: 'Dashboard', icon: 'i-lucide-layout-dashboard' },
  { to: '/connections', label: 'Connections', icon: 'i-lucide-link' },
  { to: '/repositories', label: 'Repositories', icon: 'i-lucide-git-branch' },
  { to: '/tasks', label: 'Tasks', icon: 'i-lucide-list-checks' },
  { to: '/providers', label: 'Providers', icon: 'i-lucide-bot' },
  { to: '/settings', label: 'Settings', icon: 'i-lucide-settings' },
  { to: '/system', label: 'System', icon: 'i-lucide-activity' },
  { to: '/audit', label: 'Audit', icon: 'i-lucide-shield' },
]

async function logout() {
  await api('/api/v1/auth/logout', { method: 'POST' })
  await navigateTo('/login')
}

const mobileOpen = ref(false)
</script>

<template>
  <div class="min-h-screen">
    <div class="mx-auto flex min-h-screen max-w-[1400px]">
      <aside class="aw-panel sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-y-0 border-l-0 p-4 md:flex">
        <div class="mb-8 aw-fade-in">
          <p class="font-display text-2xl tracking-tight">AI Worker</p>
          <p class="text-sm opacity-70">Platform</p>
        </div>
        <nav class="flex flex-1 flex-col gap-1">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/5"
            :class="route.path === link.to || (link.to !== '/' && route.path.startsWith(link.to)) ? 'bg-black/5 font-medium dark:bg-white/10' : 'opacity-80'"
          >
            <UIcon :name="link.icon" class="size-4" />
            {{ link.label }}
          </NuxtLink>
        </nav>
        <div class="mt-4 flex items-center gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
            @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
          />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-log-out" @click="logout">
            Logout
          </UButton>
        </div>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="aw-panel sticky top-0 z-20 flex items-center justify-between border-x-0 border-t-0 px-4 py-3 md:hidden">
          <button class="flex items-center gap-2" @click="mobileOpen = !mobileOpen">
            <UIcon name="i-lucide-menu" class="size-5" />
            <span class="font-display text-lg">AI Worker</span>
          </button>
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
            @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
          />
        </header>
        <nav v-if="mobileOpen" class="aw-panel mx-3 mt-2 flex flex-col gap-1 p-2 md:hidden">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="rounded-lg px-3 py-2 text-sm"
            @click="mobileOpen = false"
          >
            {{ link.label }}
          </NuxtLink>
        </nav>
        <main class="flex-1 p-4 md:p-8">
          <slot />
        </main>
      </div>
    </div>
  </div>
</template>
