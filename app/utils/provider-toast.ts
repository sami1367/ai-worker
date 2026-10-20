/** Toast payload for provider page feedback (Nuxt UI useToast). */
export type ProviderToastOptions = {
  title: string
  color: 'success' | 'error'
}

/** Map a status message to Nuxt UI toast options (success by default). */
export function buildProviderToast(title: string, error = false): ProviderToastOptions {
  return {
    title,
    color: error ? 'error' : 'success',
  }
}
