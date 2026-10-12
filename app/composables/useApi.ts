export function useApi() {
  const requestFetch = useRequestFetch()

  async function api<T>(url: string, opts: Parameters<typeof $fetch<T>>[1] = {}): Promise<T> {
    return await requestFetch(url, {
      ...opts,
      credentials: 'include',
    }) as Promise<T>
  }

  return { api }
}
