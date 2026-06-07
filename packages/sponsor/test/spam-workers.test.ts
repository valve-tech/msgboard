import { describe, expect, it } from 'vitest'
import { resolveWorkerCount } from '../spam-workers.js'

describe('resolveWorkerCount', () => {
  it('defaults to a single grinder when SPAM_WORKERS is unset', () => {
    expect(resolveWorkerCount(undefined)).toBe(1)
  })

  it('parses a positive integer count', () => {
    expect(resolveWorkerCount('1')).toBe(1)
    expect(resolveWorkerCount('4')).toBe(4)
    expect(resolveWorkerCount('16')).toBe(16)
  })

  it('floors fractional values to keep a whole number of threads', () => {
    expect(resolveWorkerCount('3.9')).toBe(3)
  })

  it('clamps non-positive values up to 1 (never spawns zero grinders)', () => {
    expect(resolveWorkerCount('0')).toBe(1)
    expect(resolveWorkerCount('-4')).toBe(1)
  })

  it('falls back to 1 for unparseable input', () => {
    expect(resolveWorkerCount('abc')).toBe(1)
    expect(resolveWorkerCount('')).toBe(1)
    expect(resolveWorkerCount('   ')).toBe(1)
  })
})
