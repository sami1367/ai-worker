<script setup lang="ts">
const route = useRoute()
const colorMode = useColorMode()
const { api } = useApi()
const { t } = useI18n()
const {
  readiness,
  showProviderWarning,
  showConnectionWarning,
  showRepositoryWarning,
  navNeedsAttention,
} = useSetupReadiness()

const links = [
  { to: '/', labelKey: 'nav.dashboard', icon: 'i-lucide-layout-dashboard' },
  { to: '/connections', labelKey: 'nav.connections', icon: 'i-lucide-link' },
  { to: '/repositories', labelKey: 'nav.repositories', icon: 'i-lucide-git-branch' },
  { to: '/tasks', labelKey: 'nav.tasks', icon: 'i-lucide-list-checks' },
  { to: '/providers', labelKey: 'nav.providers', icon: 'i-lucide-bot' },
  { to: '/prompts', labelKey: 'nav.prompts', icon: 'i-lucide-scroll-text' },
  { to: '/settings', labelKey: 'nav.settings', icon: 'i-lucide-settings' },
  { to: '/system', labelKey: 'nav.system', icon: 'i-lucide-activity' },
  { to: '/audit', labelKey: 'nav.audit', icon: 'i-lucide-shield' },
  { to: '/how-it-works', labelKey: 'nav.howItWorks', icon: 'i-lucide-book-open' },
  { to: '/about', labelKey: 'nav.about', icon: 'i-lucide-info' },
]

async function logout() {
  await api('/api/v1/auth/logout', { method: 'POST' })
  await navigateTo('/login')
}

const mobileOpen = ref(false)

const connectionWarningTitle = computed(() => (
  readiness.value?.connections.issue === 'unhealthy'
    ? t('setup.warn.connection.unhealthyTitle')
    : t('setup.warn.connection.title')
))

const connectionWarningDescription = computed(() => (
  readiness.value?.connections.issue === 'unhealthy'
    ? t('setup.warn.connection.unhealthyDescription')
    : t('setup.warn.connection.description')
))

const repositoryWarningDescription = computed(() => (
  readiness.value?.repositories.issue === 'none_enabled'
    ? t('setup.warn.repository.noneEnabledDescription')
    : t('setup.warn.repository.description')
))
</script>

<template>
  <div class="min-h-screen">
    <div class="mx-auto flex min-h-screen max-w-[1400px]">
      <aside class="aw-panel sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-y-0 border-s-0 p-4 md:flex">
        <div class="mb-8 aw-fade-in">
          <p class="font-display text-2xl tracking-tight">AI Worker</p>
          <p class="text-sm opacity-70">{{ t('layout.platform') }}</p>
        </div>
        <nav class="flex flex-1 flex-col gap-1" :aria-label="t('layout.mainNav')">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/5"
            :class="route.path === link.to || (link.to !== '/' && route.path.startsWith(link.to)) ? 'bg-black/5 font-medium dark:bg-white/10' : 'opacity-80'"
          >
            <UIcon :name="link.icon" class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ t(link.labelKey) }}</span>
            <span
              v-if="navNeedsAttention(link.to)"
              class="size-2 shrink-0 rounded-full bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.25)]"
              :title="t('setup.nav.needsAttention')"
              :aria-label="t('setup.nav.needsAttention')"
            />
          </NuxtLink>
        </nav>
        <div class="mt-4 space-y-2">
          <LanguageSwitcher />
          <div class="flex items-center gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
              :aria-label="colorMode.value === 'dark' ? t('layout.lightMode') : t('layout.darkMode')"
              @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
            />
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-log-out" @click="logout">
              {{ t('nav.logout') }}
            </UButton>
          </div>
        </div>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="aw-panel sticky top-0 z-20 flex items-center justify-between border-x-0 border-t-0 px-4 py-3 md:hidden">
          <button class="flex items-center gap-2" type="button" :aria-expanded="mobileOpen" aria-controls="mobile-nav" @click="mobileOpen = !mobileOpen">
            <UIcon name="i-lucide-menu" class="size-5" aria-hidden="true" />
            <span class="font-display text-lg">AI Worker</span>
          </button>
          <div class="flex items-center gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
              :aria-label="colorMode.value === 'dark' ? t('layout.lightMode') : t('layout.darkMode')"
              @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
            />
          </div>
        </header>
        <nav v-if="mobileOpen" id="mobile-nav" class="aw-panel mx-3 mt-2 flex flex-col gap-1 p-2 md:hidden" :aria-label="t('layout.mainNav')">
          <div class="mb-2 px-1">
            <LanguageSwitcher />
          </div>
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
            @click="mobileOpen = false"
          >
            <span class="min-w-0 flex-1">{{ t(link.labelKey) }}</span>
            <span
              v-if="navNeedsAttention(link.to)"
              class="size-2 shrink-0 rounded-full bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.25)]"
              :title="t('setup.nav.needsAttention')"
              :aria-label="t('setup.nav.needsAttention')"
            />
          </NuxtLink>
        </nav>
        <main class="flex-1 p-4 md:p-8">
          <div
            v-if="showProviderWarning || showConnectionWarning || showRepositoryWarning"
            class="mb-4 space-y-2"
          >
            <UAlert
              v-if="showProviderWarning"
              color="warning"
              variant="subtle"
              icon="i-lucide-bot"
              :title="t('setup.warn.provider.title')"
              :description="t('setup.warn.provider.description')"
              :actions="[{
                label: t('setup.warn.provider.action'),
                to: '/providers',
                color: 'warning',
                variant: 'soft',
              }]"
            />
            <UAlert
              v-if="showConnectionWarning"
              color="warning"
              variant="subtle"
              icon="i-lucide-link"
              :title="connectionWarningTitle"
              :description="connectionWarningDescription"
              :actions="[{
                label: t('setup.warn.connection.action'),
                to: '/connections',
                color: 'warning',
                variant: 'soft',
              }]"
            />
            <UAlert
              v-if="showRepositoryWarning"
              color="warning"
              variant="subtle"
              icon="i-lucide-git-branch"
              :title="t('setup.warn.repository.title')"
              :description="repositoryWarningDescription"
              :actions="[{
                label: t('setup.warn.repository.action'),
                to: '/repositories',
                color: 'warning',
                variant: 'soft',
              }]"
            />
          </div>
          <slot />
        </main>
        <AppFooter />
      </div>
    </div>
  </div>
</template>
