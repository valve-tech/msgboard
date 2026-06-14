import { describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import {
  type BoardClient,
  type CosignAdapter,
  type SignatureRecord,
  categoryKey,
  encodeRecord,
} from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import type { Archive, ArchiveQuery, ArchivedMessage } from '../../src/archive.js'
import { fetchRecords } from '../../src/cosign/fetch.js'
import { resolveCategories } from '../../src/cosign/categories.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const digestA = `0x${'aa'.repeat(32)}` as Hex
const digestB = `0x${'bb'.repeat(32)}` as Hex

const rec = (digest: Hex, signer: Hex): SignatureRecord => ({
  digest,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

/** Wraps encoded records (and raw junk) as RPCMessage-shaped board rows. */
const boardRows = (datas: Hex[]) =>
  datas.map(
    (data, i) =>
      ({
        version: '0x1',
        blockHash: `0x${'00'.repeat(32)}`,
        category: '0x',
        data,
        nonce: '0x0',
        workMultiplier: '0x1',
        workDivisor: '0x1',
        blockNumber: toHex(i),
        hash: keccak256(data),
      }) as unknown,
  )

/** A fake board returning canned content keyed by category. */
const fakeBoard = (byCategory: Record<Hex, Hex[]>): BoardClient => ({
  addMessage: async () => '0x',
  content: async ({ category }) => ({ [category]: boardRows(byCategory[category] ?? []) }) as Content,
})

/** A fake archive returning canned rows keyed by category. */
const fakeArchive = (byCategory: Record<Hex, Hex[]>): Archive => ({
  migrate: async () => {},
  record: async () => {},
  prune: async () => {},
  query: async (q: ArchiveQuery): Promise<ArchivedMessage[]> =>
    (byCategory[q.category as Hex] ?? []).map(
      (data, i) =>
        ({
          hash: keccak256(data),
          chain_id: 943,
          category: q.category ?? null,
          category_text: null,
          data,
          data_text: null,
          block_number: String(i),
          block_hash: null,
          first_seen_at: '2026-06-01T00:00:00.000Z',
        }) as ArchivedMessage,
    ),
})

const acceptAll: CosignAdapter = { verify: async () => true, order: (r) => r }

describe('fetchRecords', () => {
  it('decodes valid records from the board, skips junk, dedupes by raw data', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const valid = encodeRecord(rec(digestA, addr(1)))
    const junk = '0xdeadbeef' as Hex // decodeRecord throws on this
    const board = fakeBoard({ [cat]: [valid, junk, valid] }) // duplicate `valid` → deduped
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: acceptAll, now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].digest).toBe(digestA)
    expect(out[0].source).toBe('board')
  })

  it('drops a record whose adapter.verify returns false', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const good = encodeRecord(rec(digestA, addr(1)))
    const bad = encodeRecord(rec(digestA, addr(2)))
    const board = fakeBoard({ [cat]: [good, bad] })
    const rejectAddr2: CosignAdapter = { verify: async (r) => r.signer !== addr(2), order: (r) => r }
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: rejectAddr2, now: NOW })
    expect(out.map((r) => r.signer)).toEqual([addr(1)])
  })

  it('drops a record whose adapter.verify THROWS (verify-errored), without failing the fetch', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const good = encodeRecord(rec(digestA, addr(1)))
    const explodes = encodeRecord(rec(digestB, addr(9)))
    const board = fakeBoard({ [cat]: [good, explodes] })
    const throwsOn9: CosignAdapter = {
      verify: async (r) => {
        if (r.signer === addr(9)) throw new Error('not implemented')
        return true
      },
      order: (r) => r,
    }
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: throwsOn9, now: NOW })
    expect(out.map((r) => r.signer)).toEqual([addr(1)]) // the throwing one is dropped, not propagated
  })

  it('skips adapter.verify entirely when no adapter is given (accept-all)', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    const board = fakeBoard({ [cat]: [encodeRecord(rec(digestA, addr(1)))] })
    const out = await fetchRecords({ categories: cats, board, boardRetentionDays: 30, now: NOW })
    expect(out).toHaveLength(1)
  })

  it('reads recent days from the board and older days from the archive, tagging source', async () => {
    // window of 5 days; board retention = 2 days → days 0,1 from board; days 2,3,4 from archive.
    const cats = resolveCategories('cosign', 'wonderland', 5, NOW)
    const recentCat = cats[0].category // today → board
    const oldCat = cats[4].category // 4 days ago → archive
    const fromBoard = encodeRecord(rec(digestA, addr(1)))
    const fromArchive = encodeRecord(rec(digestA, addr(2)))
    const board = fakeBoard({ [recentCat]: [fromBoard] })
    const archive = fakeArchive({ [oldCat]: [fromArchive] })
    const out = await fetchRecords({
      categories: cats,
      board,
      archive,
      boardRetentionDays: 2,
      adapter: acceptAll,
      now: NOW,
    })
    const bySigner = Object.fromEntries(out.map((r) => [r.signer, r.source]))
    expect(bySigner[addr(1)]).toBe('board')
    expect(bySigner[addr(2)]).toBe('archive')
  })

  it('throws (does not silently shorten) when a needed source is unavailable', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    await expect(
      fetchRecords({ categories: cats, board, boardRetentionDays: 30, adapter: acceptAll, now: NOW }),
    ).rejects.toThrow(/rpc down/)
  })

  it('tags category_text using categoryKey inputs (provenance is present)', async () => {
    const cats = resolveCategories('cosign', 'wonderland', 1, NOW)
    const cat = cats[0].category
    expect(cat).toBe(categoryKey('cosign', 'wonderland', cats[0].isoDay))
    const board = fakeBoard({ [cat]: [encodeRecord(rec(digestA, addr(1)))] })
    const out = await fetchRecords({
      categories: cats,
      board,
      boardRetentionDays: 30,
      adapter: acceptAll,
      now: NOW,
      categoryText: (c) => `cosign:wonderland:${c.isoDay}`,
    })
    expect(out[0].category).toBe(cat)
    expect(out[0].category_text).toBe('cosign:wonderland:2026-06-13')
  })
})
