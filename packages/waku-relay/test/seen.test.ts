import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSeenStore } from '../src/seen.js'

const paths: string[] = []
const tmpPath = (name: string): string => {
  const p = join(tmpdir(), `waku-relay-seen-${name}-${process.pid}-${paths.length}.log`)
  paths.push(p)
  return p
}
afterEach(() => {
  for (const p of paths.splice(0)) rmSync(p, { force: true })
})

describe('seen store', () => {
  it('dedups in memory', () => {
    const seen = createSeenStore()
    expect(seen.has('a')).toBe(false)
    seen.remember('a')
    expect(seen.has('a')).toBe(true)
    expect(seen.size()).toBe(1)
    seen.remember('a') // idempotent
    expect(seen.size()).toBe(1)
  })

  it('persists across restarts via the append log', () => {
    const path = tmpPath('persist')
    const first = createSeenStore({ path })
    first.remember('id-1')
    first.remember('id-2')

    // a fresh store at the same path reloads the ids
    const second = createSeenStore({ path })
    expect(second.has('id-1')).toBe(true)
    expect(second.has('id-2')).toBe(true)
    expect(second.has('id-3')).toBe(false)
    expect(second.size()).toBe(2)
  })
})
