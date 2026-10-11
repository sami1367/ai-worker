export default defineNuxtRouteMiddleware(async (to) => {
  const { api } = useApi()

  let needsSetup = false
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
  } catch {
    return navigateTo('/login')
  }
})
