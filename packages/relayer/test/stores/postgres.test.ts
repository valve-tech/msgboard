import { describe, expect, it } from 'vitest'
import { postgresStore, type Queryable } from '../../src/stores/postgres.js'

const fakePool = (
  rowsByCall: unknown[][],
): Queryable & { calls: { text: string; params?: unknown[] }[] } => {
  const calls: { text: string; params?: unknown[] }[] = []
  let i = 0
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params })
      const rows = rowsByCall[i] ?? []
      i += 1
      return { rows }
    },
  }
}

describe('postgresStore', () => {
  it('migrate creates the table', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    await store.migrate()
    expect(pool.calls[0].text).toMatch(/create table if not exists sponsored/i)
  })

  it('has returns true when a row exists', async () => {
    const pool = fakePool([[{ key: 'k' }]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    expect(await store.has('k')).toBe(true)
    expect(pool.calls[0].params).toEqual(['k'])
  })

  it('has returns false when no row exists', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    expect(await store.has('k')).toBe(false)
  })

  it('remember upserts the key and its reference', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    await store.remember('k', { ok: true, ref: '0xtx' })
    expect(pool.calls[0].text).toMatch(/insert into sponsored/i)
    expect(pool.calls[0].params).toEqual(['k', '0xtx'])
  })

  it('prune deletes rows older than maxAgeMs', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    await store.prune?.()
    expect(pool.calls[0].text).toMatch(/delete from sponsored/i)
    expect(pool.calls[0].text).toMatch(/interval/i)
  })
})
