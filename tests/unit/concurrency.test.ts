import { describe, expect, it } from 'vitest'
import { mapConcurrent } from '../../shared/concurrency'
describe('bounded concurrent preparation', () => {
  it('overlaps work within the limit and keeps results in source order', async () => {
    let active = 0
    let maximum = 0
    const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 3, async value => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, value === 1 ? 10 : 1))
      active--
      return value * 2
    })
    expect(maximum).toBe(3)
    expect(results).toEqual([2, 4, 6, 8, 10, 12])
  })
  it('waits for in-flight writes before reporting failure and stops starting more work', async () => {
    let drained = false
    const started: number[] = []
    await expect(mapConcurrent([1, 2, 3, 4], 2, async value => {
      started.push(value)
      if (value === 1) throw new Error('clone failed')
      await new Promise(resolve => setTimeout(resolve, 5))
      drained = true
    })).rejects.toThrow('clone failed')
    expect(started).toEqual([1, 2])
    expect(drained).toBe(true)
  })
})
