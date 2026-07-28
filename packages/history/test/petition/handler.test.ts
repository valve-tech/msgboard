import { describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import {
  type BoardClient,
  type SignatureRecord,
  categoryKey,
  encodeRecord,
  isoDay,
} from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import {
  INDEX_SCOPE,
  PETITION_NS,
  type Petition,
  derivePetitionId,
  encodePetition,
  signScope,
} from '@msgboard/petition'
import type { Archive, ArchiveQuery, ArchivedMessage } from '../../src/archive.js'
import { type PetitionDeps, handlePetitionRequest } from '../../src/petition/handler.js'
import { matchPetitionRoute } from '../../src/petition/router.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const dayMs = 24 * 60 * 60 * 1000

const petition = (statement: string, salt: Hex): Petition => {
  const creator = addr(1)
  const id = derivePetitionId(statement, creator, salt)
  return { id, statement, creator, createdAt: Math.floor(NOW.getTime() / 1000), chainId: 943, salt }
}

const rec = (signer: Hex): SignatureRecord => ({
  digest: `0x${'aa'.repeat(32)}` as Hex,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

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

const deps = (board: BoardClient, archive?: Archive, boardRetentionDays = 30): PetitionDeps => ({
  board,
  archive,
  boardRetentionDays,
  now: () => NOW,
})

const oldIsoDay = (daysAgo: number): string => isoDay(new Date(NOW.getTime() - daysAgo * dayMs))

describe('handlePetitionRequest', () => {
  it('index: returns decoded descriptors posted across board+archive, deduped by id', async () => {
    const p1 = petition('build a park', `0x${'01'.repeat(32)}` as Hex)
    const p2 = petition('fix the road', `0x${'02'.repeat(32)}` as Hex)
    const todayCat = categoryKey(PETITION_NS, INDEX_SCOPE, isoDay(NOW))
    const oldCat = categoryKey(PETITION_NS, INDEX_SCOPE, oldIsoDay(5))

    const board = fakeBoard({ [todayCat]: [encodePetition(p1)] })
    const archive = fakeArchive({ [oldCat]: [encodePetition(p2)] })

    const route = matchPetitionRoute('/petition/index')!
    const r = await handlePetitionRequest(
      route,
      new URLSearchParams('days=7'),
      deps(board, archive, 3),
    )
    expect(r.status).toBe(200)
    const body = r.body as { petitions: Petition[] }
    expect(body.petitions.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort())
    // JSON-safe: descriptor fields round-trip through JSON.stringify without loss.
    expect(JSON.parse(JSON.stringify(body))).toEqual(body)
  })

  it('index: 502 when the board fetch fails', async () => {
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    const route = matchPetitionRoute('/petition/index')!
    const r = await handlePetitionRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toMatch(/rpc down/)
  })

  it('tally: returns a deduped count over board+archive', async () => {
    const id = `0x${'03'.repeat(32)}` as Hex
    const scope = signScope(id)
    const todayCat = categoryKey(PETITION_NS, scope, isoDay(NOW))
    const oldCat = categoryKey(PETITION_NS, scope, oldIsoDay(5))

    const board = fakeBoard({
      [todayCat]: [encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))],
    })
    const archive = fakeArchive({
      [oldCat]: [encodeRecord(rec(addr(2))), encodeRecord(rec(addr(3)))],
    })

    const route = matchPetitionRoute(`/petition/${id}/tally`)!
    const r = await handlePetitionRequest(
      route,
      new URLSearchParams('days=7'),
      deps(board, archive, 3),
    )
    expect(r.status).toBe(200)
    const body = r.body as { id: Hex; count: number; signers: Hex[] }
    expect(body.id).toBe(id)
    expect(body.count).toBe(3) // addr(2) deduped across board+archive
    expect(body.signers.sort()).toEqual([addr(1), addr(2), addr(3)].sort())
  })

  it('tally: signers default-cap at 200 (not the full set) and page via offset/limit', async () => {
    const id = `0x${'06'.repeat(32)}` as Hex
    const scope = signScope(id)
    const todayCat = categoryKey(PETITION_NS, scope, isoDay(NOW))
    const signers = Array.from({ length: 250 }, (_, i) => addr(i + 1))
    const board = fakeBoard({ [todayCat]: signers.map((a) => encodeRecord(rec(a))) })
    const route = matchPetitionRoute(`/petition/${id}/tally`)!

    // No ?limit — must NOT dump all 250 signers.
    const noLimit = await handlePetitionRequest(route, new URLSearchParams('days=7'), deps(board))
    expect(noLimit.status).toBe(200)
    const bodyNoLimit = noLimit.body as { count: number; signers: Hex[] }
    expect(bodyNoLimit.count).toBe(250) // count is always the FULL deduped signer count
    expect(bodyNoLimit.signers).toHaveLength(200) // signers is capped to the default page size

    // Page through the rest via offset/limit.
    const page2 = await handlePetitionRequest(
      route,
      new URLSearchParams('days=7&offset=200&limit=100'),
      deps(board),
    )
    const bodyPage2 = page2.body as { count: number; signers: Hex[] }
    expect(bodyPage2.count).toBe(250)
    expect(bodyPage2.signers).toHaveLength(50) // the remaining 50 signers
    expect(new Set([...bodyNoLimit.signers, ...bodyPage2.signers]).size).toBe(250) // union = all
  })

  it('signatures: supports offset/limit pagination', async () => {
    const id = `0x${'04'.repeat(32)}` as Hex
    const scope = signScope(id)
    const todayCat = categoryKey(PETITION_NS, scope, isoDay(NOW))
    const board = fakeBoard({
      [todayCat]: [addr(1), addr(2), addr(3)].map((a) => encodeRecord(rec(a))),
    })

    const route = matchPetitionRoute(`/petition/${id}/signatures`)!
    const full = await handlePetitionRequest(route, new URLSearchParams('days=7'), deps(board))
    expect((full.body as { total: number }).total).toBe(3)
    expect((full.body as { signatures: unknown[] }).signatures).toHaveLength(3)

    const page = await handlePetitionRequest(
      route,
      new URLSearchParams('days=7&offset=1&limit=1'),
      deps(board),
    )
    expect(page.status).toBe(200)
    const body = page.body as { signatures: { signer: Hex }[]; total: number }
    expect(body.signatures).toHaveLength(1)
    expect(body.total).toBe(3)
  })

  it('signatures: 502 when the board fetch fails', async () => {
    const id = `0x${'05'.repeat(32)}` as Hex
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    const route = matchPetitionRoute(`/petition/${id}/signatures`)!
    const r = await handlePetitionRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(502)
  })

  it('clamps days over windowDays (does not error)', async () => {
    let askedDays = 0
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async ({ category }) => {
        askedDays++
        return { [category]: [] } as Content
      },
    }
    const route = matchPetitionRoute('/petition/index')!
    const r = await handlePetitionRequest(route, new URLSearchParams('days=999'), deps(board))
    expect(r.status).toBe(200)
    expect(askedDays).toBe(7) // clamped to the default windowDays, so 7 categories fetched
  })
})
