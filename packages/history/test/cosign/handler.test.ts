import { describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import {
  type BoardClient,
  type CosignAdapter,
  type SignatureRecord,
  encodeRecord,
} from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'
import { matchCosignRoute } from '../../src/cosign/router.js'
import { handleCosignRequest, type CosignDeps } from '../../src/cosign/handler.js'
import { loadTeamFile } from '../../src/cosign/team-file.js'

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const digest = `0x${'aa'.repeat(32)}` as Hex
const rec = (signer: Hex): SignatureRecord => ({
  digest,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

describe('matchCosignRoute', () => {
  it('parses the three endpoint shapes and the optional owners passthrough', () => {
    expect(matchCosignRoute('/cosign/cosign/wonderland/signatures')).toEqual({
      kind: 'signatures',
      namespace: 'cosign',
      scope: 'wonderland',
    })
    expect(matchCosignRoute('/cosign/cosign/wonderland/digest/0xdead')).toEqual({
      kind: 'digest',
      namespace: 'cosign',
      scope: 'wonderland',
      digest: '0xdead',
    })
    expect(matchCosignRoute('/cosign/cosign/wonderland/digest/0xdead/aggregate')).toEqual({
      kind: 'aggregate',
      namespace: 'cosign',
      scope: 'wonderland',
      digest: '0xdead',
    })
    expect(matchCosignRoute('/cosign/cosign/wonderland/owners')).toEqual({
      kind: 'owners',
      namespace: 'cosign',
      scope: 'wonderland',
    })
  })

  it('returns null for non-cosign / malformed paths', () => {
    expect(matchCosignRoute('/messages')).toBeNull()
    expect(matchCosignRoute('/cosign/cosign')).toBeNull()
    expect(matchCosignRoute('/cosign/cosign/wonderland/digest')).toBeNull() // missing :digest
  })
})

const NOW = new Date('2026-06-13T12:00:00.000Z')

const boardWith = (datas: Hex[]): BoardClient => ({
  addMessage: async () => '0x',
  content: async ({ category }) =>
    ({
      [category]: datas.map(
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
      ),
    }) as Content,
})

const acceptAll: CosignAdapter = { verify: async () => true, order: (r) => r }

const deps = (board: BoardClient, adapter: CosignAdapter = acceptAll): CosignDeps => ({
  teamFile: loadTeamFile({
    version: 1,
    namespace: 'cosign',
    windowDays: 7,
    teams: [{ scope: 'wonderland' }],
    adapter: { kind: 'none' },
  }),
  board,
  adapter,
  boardRetentionDays: 30,
  now: () => NOW,
})

describe('handleCosignRequest', () => {
  it('signatures: returns decoded valid records in the window', async () => {
    const board = boardWith([encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))])
    const route = matchCosignRoute('/cosign/cosign/wonderland/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams('days=7'), deps(board))
    expect(r.status).toBe(200)
    expect((r.body as { signatures: unknown[] }).signatures).toHaveLength(2)
  })

  it('digest: returns all signatures for a digest + signers', async () => {
    const board = boardWith([encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))])
    const route = matchCosignRoute(`/cosign/cosign/wonderland/digest/${digest}`)!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(200)
    const body = r.body as { digest: Hex; signers: Hex[]; count: number }
    expect(body.digest).toBe(digest)
    expect(body.signers.sort()).toEqual([addr(1), addr(2)].sort())
    expect(body.count).toBe(2)
  })

  it('aggregate: returns the aggregate-ready ordered {signer,signature}[] with ready vs threshold', async () => {
    const board = boardWith([encodeRecord(rec(addr(1))), encodeRecord(rec(addr(2)))])
    const route = matchCosignRoute(`/cosign/cosign/wonderland/digest/${digest}/aggregate`)!
    const r = await handleCosignRequest(route, new URLSearchParams('threshold=2'), deps(board))
    expect(r.status).toBe(200)
    const body = r.body as {
      signers: { signer: Hex; signature: Hex }[]
      count: number
      threshold: number
      ready: boolean
    }
    expect(body.count).toBe(2)
    expect(body.threshold).toBe(2)
    expect(body.ready).toBe(true)
    expect(body.signers.map((s) => s.signer).sort()).toEqual([addr(1), addr(2)].sort())
  })

  it('aggregate: ready=false when count < threshold', async () => {
    const board = boardWith([encodeRecord(rec(addr(1)))])
    const route = matchCosignRoute(`/cosign/cosign/wonderland/digest/${digest}/aggregate`)!
    const r = await handleCosignRequest(route, new URLSearchParams('threshold=2'), deps(board))
    expect((r.body as { ready: boolean }).ready).toBe(false)
  })

  it('rejects an unknown scope with 404', async () => {
    const board = boardWith([])
    const route = matchCosignRoute('/cosign/cosign/stranger/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(404)
    expect((r.body as { error: string }).error).toMatch(/unknown scope/)
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
    const route = matchCosignRoute('/cosign/cosign/wonderland/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams('days=999'), deps(board))
    expect(r.status).toBe(200)
    expect(askedDays).toBe(7) // clamped to windowDays, so 7 categories fetched
  })

  it('returns 502 when the board fetch fails', async () => {
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async () => {
        throw new Error('rpc down')
      },
    }
    const route = matchCosignRoute('/cosign/cosign/wonderland/signatures')!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toMatch(/rpc down/)
  })

  it('owners: 501 when the adapter does not implement owners()', async () => {
    const board = boardWith([])
    const route = matchCosignRoute('/cosign/cosign/wonderland/owners')!
    const r = await handleCosignRequest(route, new URLSearchParams(), deps(board))
    expect(r.status).toBe(501)
  })
})
