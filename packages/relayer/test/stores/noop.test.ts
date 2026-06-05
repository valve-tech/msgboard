import { describe, expect, it } from 'vitest'
import { noopStore } from '../../src/stores/noop.js'

describe('noopStore', () => {
  it('never reports a key as seen, even after remember', async () => {
    const store = noopStore()
    await store.remember('x', { ok: true })
    expect(await store.has('x')).toBe(false)
  })
})
