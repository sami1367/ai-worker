export default defineNuxtRouteMiddleware(async (to) => {
  const { api } = useApi()
  // Per Nuxt app/session, hydrated from SSR; never shared between users.
  const checkedAt = useState<number>('auth-checked-at', () => 0)
  const publicPage = to.path === '/login' || to.path === '/setup'
  if (publicPage) checkedAt.value = 0
  if (!publicPage && Date.now() - checkedAt.value < 60_000) return

  let needsSetup: boolean
  try {
    const setup = await api<{ needsSetup: boolean }>('/api/v1/auth/setup-status')
    needsSetup = setup.needsSetup
  } catch {
    // If API is unreachable, allow login page to render the error state
    if (to.path !== '/login' && to.path !== '/setup') return navigateTo('/login')
    return
  }

  if (needsSetup) {
    if (to.path !== '/setup') return navigateTo('/setup')
    return
  }

  if (to.path === '/setup') return navigateTo('/login')
  if (to.path === '/login') return

  try {
    await api('/api/v1/auth/me')
    checkedAt.value = Date.now()
  } catch {
    return navigateTo('/login')
  }
})
