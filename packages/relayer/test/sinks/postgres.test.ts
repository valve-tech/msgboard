import { describe, expect, it } from 'vitest'
import { postgresSink } from '../../src/sinks/postgres.js'
import type { Queryable } from '../../src/stores/postgres.js'
import type { RelayerContext } from '../../src/types.js'

const fakePool = (): Queryable & { calls: { text: string; params?: unknown[] }[] } => {
  const calls: { text: string; params?: unknown[] }[] = []
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params })
      return { rows: [] }
    },
  }
}

const ctx = {} as RelayerContext

describe('postgresSink', () => {
  it('migrate creates the configured table with a key and payload column', async () => {
    const pool = fakePool()
    const sink = postgresSink<{ address: string }>({
      pool,
      table: 'flagged',
      toRow: (item) => ({ key: item.address, payload: { address: item.address } }),
    })
    await sink.migrate()
    expect(pool.calls[0].text).toMatch(/create table if not exists flagged/i)
  })

  it('record upserts the mapped row', async () => {
    const pool = fakePool()
    const sink = postgresSink<{ address: string }>({
      pool,
      table: 'flagged',
      toRow: (item) => ({ key: item.address, payload: { address: item.address } }),
    })
    await sink.record({ address: '0xabc' }, ctx)
    expect(pool.calls[0].text).toMatch(/insert into flagged/i)
    expect(pool.calls[0].params?.[0]).toBe('0xabc')
  })
})
