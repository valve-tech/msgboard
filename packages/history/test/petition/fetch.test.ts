import { describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import type { BoardClient } from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import { type Petition, derivePetitionId, encodePetition } from '@msgboard/petition'
import type { Archive, ArchiveQuery, ArchivedMessage } from '../../src/archive.js'
import { resolveIndexCategories } from '../../src/petition/categories.js'
import { fetchPetitions } from '../../src/petition/fetch.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex

const petition = (statement: string, salt: Hex): Petition => {
  const creator = addr(1)
  const id = derivePetitionId(statement, creator, salt)
  return {
    id,
    statement,
    creator,
    createdAt: Math.floor(NOW.getTime() / 1000),
    chainId: 943,
    salt,
  }
}

/** Wraps encoded descriptors (and raw junk) as RPCMessage-shaped board rows. */
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

const fakeBoard = (byCategory: Record<Hex, Hex[]>): BoardClient => ({
  addMessage: async () => '0x',
  content: async ({ category }) =>
    ({ [category]: boardRows(byCategory[category] ?? []) }) as Content,
})

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

describe('fetchPetitions', () => {
  it('decodes valid descriptors from the board, skips junk, dedupes by raw data', async () => {
    const cats = resolveIndexCategories(1, NOW)
    const cat = cats[0].category
    const p = petition('build a park', `0x${'01'.repeat(32)}` as Hex)
    const valid = encodePetition(p)
    const junk = '0xdeadbeef' as Hex // decodePetition throws on this
    const board = fakeBoard({ [cat]: [valid, junk, valid] }) // duplicate `valid` → deduped
    const out = await fetchPetitions({ categories: cats, board, boardRetentionDays: 30, now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(p.id)
    expect(out[0].source).toBe('board')
  })

  it('dedupes by petition id even when reposted under a different day (different raw bytes)', async () => {
    const cats = resolveIndexCategories(2, NOW)
    const today = cats[0].category
    const yesterday = cats[1].category
    const p = petition('same petition, reposted', `0x${'02'.repeat(32)}` as Hex)
    const board = fakeBoard({ [today]: [encodePetition(p)], [yesterday]: [encodePetition(p)] })
    const out = await fetchPetitions({ categories: cats, board, boardRetentionDays: 30, now: NOW })
    expect(out).toHaveLength(1)
  })

  it('reads recent days from the board and older days from the archive, tagging source', async () => {
    // window of 5 days; board retention = 2 days → days 0,1 from board; days 2,3,4 from archive.
    const cats = resolveIndexCategories(5, NOW)
    const recentCat = cats[0].category // today → board
    const oldCat = cats[4].category // 4 days ago → archive
    const fromBoard = petition('board petition', `0x${'03'.repeat(32)}` as Hex)
    const fromArchive = petition('archive petition', `0x${'04'.repeat(32)}` as Hex)
    const board = fakeBoard({ [recentCat]: [encodePetition(fromBoard)] })
    const archive = fakeArchive({ [oldCat]: [encodePetition(fromArchive)] })
    const out = await fetchPetitions({
      categories: cats,
      board,
      archive,
      boardRetentionDays: 2,
      now: NOW,
    })
    const bySource = Object.fromEntries(out.map((p) => [p.id, p.source]))
    expect(bySource[fromBoard.id]).toBe('board')
    expect(bySource[fromArchive.id]).toBe('archive')
  })

  it('throws (does not silently shorten) when a needed source is unavailable', async () => {
    const cats = resolveIndexCategories(1, NOW)
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    await expect(
      fetchPetitions({ categories: cats, board, boardRetentionDays: 30, now: NOW }),
    ).rejects.toThrow(/rpc down/)
  })

  it('tags category_text using the provided label builder', async () => {
    const cats = resolveIndexCategories(1, NOW)
    const cat = cats[0].category
    const p = petition('labeled petition', `0x${'05'.repeat(32)}` as Hex)
    const board = fakeBoard({ [cat]: [encodePetition(p)] })
    const out = await fetchPetitions({
      categories: cats,
      board,
      boardRetentionDays: 30,
      now: NOW,
      categoryText: (c) => `petition:index:${c.isoDay}`,
    })
    expect(out[0].category).toBe(cat)
    expect(out[0].category_text).toBe('petition:index:2026-06-13')
  })
})
