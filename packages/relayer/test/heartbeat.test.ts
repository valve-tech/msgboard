import { describe, expect, it } from 'vitest'
import { HEARTBEAT_TABLE, postgresHeartbeat } from '../src/heartbeat.js'
import type { Queryable } from '../src/stores/postgres.js'

/** Records what the writer sends, so the SQL and its parameters can be asserted. */
const fakePool = () => {
  const calls: { text: string; params?: unknown[] }[] = []
  const pool: Queryable = {
    query: async (text, params) => {
      calls.push({ text, params })
      return { rows: [] }
    },
  }
  return { pool, calls }
}

describe('postgresHeartbeat.migrate', () => {
  it('creates the table if it is absent, so a fresh box needs no manual step', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).migrate()
    expect(calls[0]!.text).toContain('CREATE TABLE IF NOT EXISTS')
    expect(calls[0]!.text).toContain(HEARTBEAT_TABLE)
  })

  it('carries an existing single-key table forward instead of needing a hand migration', async () => {
    // The first version keyed on chain_id alone and is already live on the box. An
    // operator must not have to run anything by hand for the replica-aware version.
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).migrate()
    const sql = calls.map((c) => c.text).join('\n')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS source')
    expect(sql).toContain('ADD PRIMARY KEY (chain_id, source)')
  })

  it('drops the carried-over placeholder row, which would alert forever', async () => {
    // A row from the single-key version keeps source='default' and never ticks again,
    // so a "last_tick_at is stale" alert would fire on it permanently. Every live
    // relayer rewrites its own row within one tick, so deleting it costs nothing.
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).migrate()
    expect(calls.map((c) => c.text).join('\n')).toContain("DELETE FROM indexer_heartbeat WHERE source = 'default'")
  })

  it('writes one row per endpoint, so a replica split is visible as two rows', async () => {
    const { pool, calls } = fakePool()
    const hb = postgresHeartbeat({ pool })
    await hb.beat({ chainId: 1, source: 'ep-a', polled: 33, recorded: 33 })
    await hb.beat({ chainId: 1, source: 'ep-b', polled: 0, recorded: 0 })
    expect(calls.map((c) => c.params![4])).toEqual(['ep-a', 'ep-b'])
    expect(calls.map((c) => c.params![1])).toEqual([33, 0])
  })

  it('honours a custom table name', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool, table: 'other_heartbeat' }).migrate()
    expect(calls[0]!.text).toContain('other_heartbeat')
  })
})

describe('postgresHeartbeat.beat', () => {
  it('writes the chain id, the counts and the head block', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({
      chainId: 943,
      source: 'https://one.example.test/rpc/<redacted>/evm/943',
      polled: 12,
      recorded: 3,
      headBlock: 27_489_974n,
    })
    expect(calls[0]!.params).toEqual([943, 12, 3, '27489974', 'https://one.example.test/rpc/<redacted>/evm/943'])
  })

  it('sends the head block as text, so a large block number keeps its precision', async () => {
    // Past 2^53 a JavaScript number silently rounds. PulseChain will get there.
    const { pool, calls } = fakePool()
    const huge = 9_007_199_254_740_995n
    await postgresHeartbeat({ pool }).beat({ chainId: 1, source: 'ep-a', polled: 0, recorded: 0, headBlock: huge })
    expect(calls[0]!.params![3]).toBe('9007199254740995')
  })

  it('writes null for the head block when the node did not answer', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({ chainId: 1, source: 'ep-a', polled: 0, recorded: 0, headBlock: null })
    expect(calls[0]!.params![3]).toBeNull()
  })

  it('records an empty tick rather than skipping it', async () => {
    // The whole point. A chain with an empty board must still prove it is alive,
    // or "healthy and quiet" stays indistinguishable from "dead".
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({ chainId: 1, source: 'ep-a', polled: 0, recorded: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params!.slice(0, 3)).toEqual([1, 0, 0])
  })

  it('upserts on the chain id, so one row per chain survives a restart', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({ chainId: 369, source: 'ep-a', polled: 1, recorded: 1 })
    expect(calls[0]!.text).toContain('ON CONFLICT (chain_id, source) DO UPDATE')
  })

  it('always moves last_tick_at, which is the liveness signal', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({ chainId: 1, source: 'ep-a', polled: 0, recorded: 0 })
    expect(calls[0]!.text).toContain('last_tick_at = now()')
  })

  it('advances last_message_at only on a tick that saw a message', async () => {
    // This column answers "when did anyone last write to this board?". An empty
    // tick must not touch it, or the answer becomes "always now" and the dead
    // writers that caused this whole investigation stay invisible.
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({ chainId: 1, source: 'ep-a', polled: 0, recorded: 0 })
    expect(calls[0]!.text).toContain(`last_message_at = CASE WHEN $2 > 0 THEN now() ELSE ${HEARTBEAT_TABLE}.last_message_at END`)
  })

  it('keeps the last known head block when the node is unreachable', async () => {
    const { pool, calls } = fakePool()
    await postgresHeartbeat({ pool }).beat({ chainId: 1, source: 'ep-a', polled: 0, recorded: 0, headBlock: null })
    expect(calls[0]!.text).toContain('COALESCE($4')
  })
})
