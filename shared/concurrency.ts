/** Bounded parallel work; preserve order and drain in-flight tasks before reporting failure. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer')
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await map(items[index]!, index) } catch (error) { failed = true; failure = error }
    }
  }))
  if (failed) throw failure
  return results
}
