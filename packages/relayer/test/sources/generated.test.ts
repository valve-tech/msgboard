import { describe, expect, it } from 'vitest'
import { generatedSource } from '../../src/sources/generated.js'
import type { RelayerContext } from '../../src/types.js'

const ctx = {} as RelayerContext

describe('generatedSource', () => {
  it('yields exactly one produced item per poll', async () => {
    let n = 0
    const source = generatedSource(() => ({ value: (n += 1) }))
    const first = await source.poll(ctx)
    const second = await source.poll(ctx)
    expect(first).toEqual([{ value: 1 }])
    expect(second).toEqual([{ value: 2 }])
  })

  it('supports async producers', async () => {
    const source = generatedSource(async () => 'hello')
    expect(await source.poll(ctx)).toEqual(['hello'])
  })
})
