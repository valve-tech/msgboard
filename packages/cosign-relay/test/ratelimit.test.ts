import { describe, expect, it } from 'vitest'
import { createRateLimiter } from '../src/ratelimit.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('createRateLimiter', () => {
  it('allows up to perDay requests for a key, then blocks', () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const limiter = createRateLimiter({ perDay: 3, now: () => now })
    expect(limiter.take('1.2.3.4')).toBe(true)
    expect(limiter.take('1.2.3.4')).toBe(true)
    expect(limiter.take('1.2.3.4')).toBe(true)
    expect(limiter.take('1.2.3.4')).toBe(false)
    expect(limiter.take('1.2.3.4')).toBe(false)
  })

  it('tracks keys independently', () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const limiter = createRateLimiter({ perDay: 1, now: () => now })
    expect(limiter.take('a')).toBe(true)
    expect(limiter.take('a')).toBe(false)
    expect(limiter.take('b')).toBe(true)
    expect(limiter.take('b')).toBe(false)
  })

  it('resets the count when `now` advances to a new UTC day', () => {
    let now = Date.UTC(2026, 0, 1, 23, 59, 0)
    const limiter = createRateLimiter({ perDay: 1, now: () => now })
    expect(limiter.take('x')).toBe(true)
    expect(limiter.take('x')).toBe(false)
    now += 2 * 60 * 1000 // cross into 2026-01-02 UTC
    expect(limiter.take('x')).toBe(true)
  })

  it('does not reset within the same UTC day even after many hours', () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const limiter = createRateLimiter({ perDay: 1, now: () => now })
    expect(limiter.take('y')).toBe(true)
    now += DAY_MS - 1000 // still 2026-01-01 UTC, one second before midnight
    expect(limiter.take('y')).toBe(false)
  })
})
