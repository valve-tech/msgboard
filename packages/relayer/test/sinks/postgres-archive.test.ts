import { describe, expect, it } from 'vitest'
import { stringToHex } from 'viem'
import { postgresArchiveSink } from '../../src/sinks/postgres-archive.js'
import type { Queryable } from '../../src/stores/postgres.js'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerContext } from '../../src/types.js'

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

const ctx = { chain: { id: 943 } } as unknown as RelayerContext

const message = (over: Partial<RPCMessage> = {}): RPCMessage =>
  ({
    version: '0x1',
    blockHash: '0xabc',
    blockNumber: '0x10',
    category: stringToHex('lorem', { size: 32 }),
    data: stringToHex('hello world', { size: 11 }),
    hash: '0xdeadbeef',
    nonce: '0x5',
    workMultiplier: '0x2710',
    workDivisor: '0xf4240',
    ...over,
  }) as RPCMessage

describe('postgresArchiveSink', () => {
  it('migrate creates the message_archive table and indexes', async () => {
    const pool = fakePool([[], [], [], []])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    await sink.migrate()
    expect(pool.calls[0].text).toMatch(/create table if not exists message_archive/i)
    expect(pool.calls.some((c) => /create index/i.test(c.text))).toBe(true)
  })

  it('record upserts on (hash, chain_id) with decoded content', async () => {
    const pool = fakePool([[]])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    await sink.record(message(), ctx)
    const call = pool.calls[0]
    expect(call.text).toMatch(/insert into message_archive/i)
    expect(call.text).toMatch(/on conflict \(hash, chain_id\) do nothing/i)
    // params: hash, chain_id, category, category_text, data, content, block_number, block_hash
    expect(call.params?.[0]).toBe('0xdeadbeef')
    expect(call.params?.[1]).toBe(943)
    expect(call.params?.[3]).toBe('lorem') // decoded category text
    expect(call.params?.[5]).toBe('hello world') // decoded content
  })

  it('prune deletes rows older than the retention window', async () => {
    const pool = fakePool([[]])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    await sink.prune?.()
    expect(pool.calls[0].text).toMatch(/delete from message_archive/i)
    expect(pool.calls[0].text).toMatch(/365 days/i)
  })

  it('query builds a filtered select and returns rows', async () => {
    const pool = fakePool([[{ hash: '0x1' }]])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    const rows = await sink.query({ chainId: 943, category: 'lorem', limit: 10 })
    expect(rows).toEqual([{ hash: '0x1' }])
    expect(pool.calls[0].text).toMatch(/select .* from message_archive/i)
    expect(pool.calls[0].text).toMatch(/where/i)
    expect(pool.calls[0].text).toMatch(/limit/i)
  })
})
