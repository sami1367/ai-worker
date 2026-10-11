export function useApi() {
  async function api<T>(url: string, opts: Parameters<typeof $fetch<T>>[1] = {}): Promise<T> {
    return await $fetch<T>(url, {
      ...opts,
      credentials: 'include',
    })
  }
  return { api }
}
