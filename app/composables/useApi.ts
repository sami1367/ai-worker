export function useApi() {
  const requestFetch = useRequestFetch()
  const checkedAt = useState<number>('auth-checked-at', () => 0)

  async function api<T>(url: string, opts: Parameters<typeof $fetch<T>>[1] = {}): Promise<T> {
    try {
      const result = await requestFetch(url, {
        ...opts,
        credentials: 'include',
      }) as T
      if (url.startsWith('/api/v1/auth/') && opts?.method && opts.method !== 'GET') {
        checkedAt.value = 0
      }
      if (import.meta.client && opts?.method && opts.method !== 'GET'
        && /^\/api\/v1\/(connections|repositories|providers)(\/|$)/.test(url)) {
        void refreshNuxtData('setup-readiness')
      }
      return result
    } catch (error: unknown) {
      const status = error && typeof error === 'object'
        ? (error as { statusCode?: number, status?: number })
        : undefined
      if (status?.statusCode === 401 || status?.status === 401) {
        checkedAt.value = 0
        if (import.meta.client && !url.startsWith('/api/v1/auth/')) void navigateTo('/login')
      }
      throw error
    }
  }

  return { api }
}
