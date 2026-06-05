import { describe, expect, it, vi } from 'vitest'
import { memoryTtlStore } from '../../src/stores/memory-ttl.js'

describe('memoryTtlStore', () => {
  it('does not know an unseen key', async () => {
    const store = memoryTtlStore({ ttlMs: 1000 })
    expect(await store.has('x')).toBe(false)
  })

  it('knows a remembered key within the time-to-live', async () => {
    const store = memoryTtlStore({ ttlMs: 1000 })
    await store.remember('x', { ok: true })
    expect(await store.has('x')).toBe(true)
  })

  it('forgets a key after the time-to-live elapses', async () => {
    vi.useFakeTimers()
    const store = memoryTtlStore({ ttlMs: 1000 })
    await store.remember('x', { ok: true })
    vi.advanceTimersByTime(1001)
    expect(await store.has('x')).toBe(false)
    vi.useRealTimers()
  })

  it('prune drops expired keys', async () => {
    vi.useFakeTimers()
    const store = memoryTtlStore({ ttlMs: 1000 })
    await store.remember('x', { ok: true })
    vi.advanceTimersByTime(1001)
    await store.prune?.()
    expect(await store.has('x')).toBe(false)
    vi.useRealTimers()
  })
})
