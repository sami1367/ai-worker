export type SetupReadiness = {
  connections: { ok: boolean, total: number, active: number, issue: 'none' | 'unhealthy' | null }
  providers: { ok: boolean, total: number, active: number, issue: 'none' | null }
  repositories: { ok: boolean, total: number, enabled: number, issue: 'none' | 'none_enabled' | null }
  navWarnings: {
    connections: boolean
    providers: boolean
    repositories: boolean
  }
}

export function useSetupReadiness() {
  const { api } = useApi()
  const route = useRoute()

  const { data, pending, refresh, error } = useAsyncData(
    'setup-readiness',
    () => api<SetupReadiness>('/api/v1/setup/readiness'),
    {
      lazy: true,
      server: false,
      default: () => null,
    },
  )

  watch(() => route.fullPath, () => {
    void refresh()
  })

  if (import.meta.client) {
    onMounted(() => {
      const timer = setInterval(() => {
        void refresh()
      }, 60_000)
      onUnmounted(() => clearInterval(timer))
    })
  }

  const showProviderWarning = computed(() => data.value?.providers.ok === false)
  const showConnectionWarning = computed(() => data.value?.connections.ok === false)
  const showRepositoryWarning = computed(() => (
    data.value?.connections.ok === true && data.value?.repositories.ok === false
  ))

  function navNeedsAttention(path: string): boolean {
    const nav = data.value?.navWarnings
    if (!nav) return false
    if (path === '/connections') return nav.connections
    if (path === '/providers') return nav.providers
    if (path === '/repositories') return nav.repositories
    return false
  }

  return {
    readiness: data,
    pending,
    error,
    refresh,
    showProviderWarning,
    showConnectionWarning,
    showRepositoryWarning,
    navNeedsAttention,
  }
}
