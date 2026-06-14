import { afterEach, describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import { type BoardClient, type CosignAdapter, type SignatureRecord, postSignature } from '@msgboard/cosign'
import type { Content, RPCMessage } from '@msgboard/sdk'
import { archiveServer, type ArchiveServer } from '../../src/server.js'

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const digest = `0x${'aa'.repeat(32)}` as Hex
const NOW = new Date('2026-06-13T12:00:00.000Z')

const rec = (signer: Hex): SignatureRecord => ({
  digest,
  signer,
  signature: `0x${'cd'.repeat(65)}` as Hex,
  scheme: 0,
  meta: '0x',
})

/** A tiny in-memory board the cosign SDK can post into and the route can read from. */
const memoryBoard = (): BoardClient => {
  const store = new Map<Hex, RPCMessage[]>()
  return {
    addMessage: async ({ category, data }) => {
      const list = store.get(category) ?? []
      list.push({
        version: '0x1',
        blockHash: `0x${'00'.repeat(32)}`,
        category,
        data,
        nonce: '0x0',
        workMultiplier: '0x1',
        workDivisor: '0x1',
        blockNumber: toHex(list.length),
        hash: keccak256(data),
      } as unknown as RPCMessage)
      store.set(category, list)
      return keccak256(data)
    },
    content: async ({ category }) => ({ [category]: store.get(category) ?? [] }) as Content,
  }
}

const stubArchive = () => ({
  migrate: async () => {},
  record: async () => {},
  prune: async () => {},
  query: async () => [],
})
const acceptAll: CosignAdapter = { verify: async () => true, order: (r) => r }

let nextPort = 34810
const open = new Set<ArchiveServer>()
const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url, { headers })
    } catch (err) {
      if (!(err instanceof Error && /ECONNREFUSED|fetch failed/.test(err.message))) throw err
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  throw new Error(`server at ${url} never accepted a connection`)
}
afterEach(async () => {
  await Promise.all([...open].map((s) => s.close()))
  open.clear()
})

const startWithCosign = (board: BoardClient, token?: string) => {
  const port = nextPort++
  const server = archiveServer({
    archive: stubArchive() as never,
    port,
    token,
    cosign: {
      board,
      adapter: acceptAll,
      boardRetentionDays: 30,
      now: () => NOW,
      teamFile: {
        version: 1,
        namespace: 'cosign',
        windowDays: 7,
        teams: [{ scope: 'wonderland' }],
        adapter: { kind: 'none' },
      },
    },
  })
  open.add(server)
  return { base: `http://127.0.0.1:${port}` }
}

describe('archiveServer with cosign option (integration)', () => {
  it('post via cosign SDK → query the route → aggregate-ready set comes back', async () => {
    const board = memoryBoard()
    // post two signatures for the same digest under today's rotating category
    await postSignature(board, { namespace: 'cosign', scope: 'wonderland', record: rec(addr(1)), now: NOW })
    await postSignature(board, { namespace: 'cosign', scope: 'wonderland', record: rec(addr(2)), now: NOW })

    const { base } = startWithCosign(board)
    const res = await get(`${base}/cosign/cosign/wonderland/digest/${digest}/aggregate?days=7&threshold=2`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.ready).toBe(true)
    expect(body.signers.map((s: { signer: Hex }) => s.signer).sort()).toEqual([addr(1), addr(2)].sort())
  })

  it('signatures endpoint returns the decoded window', async () => {
    const board = memoryBoard()
    await postSignature(board, { namespace: 'cosign', scope: 'wonderland', record: rec(addr(1)), now: NOW })
    const { base } = startWithCosign(board)
    const res = await get(`${base}/cosign/cosign/wonderland/signatures?days=7`)
    expect((await res.json()).signatures).toHaveLength(1)
  })

  it('unknown scope → 404 through the server', async () => {
    const { base } = startWithCosign(memoryBoard())
    expect((await get(`${base}/cosign/cosign/stranger/signatures`)).status).toBe(404)
  })

  it('shares /health and still serves /messages', async () => {
    const { base } = startWithCosign(memoryBoard())
    expect((await get(`${base}/health`)).status).toBe(200)
    expect((await get(`${base}/messages`)).status).toBe(200)
  })

  it('cosign endpoints honor the bearer token', async () => {
    const { base } = startWithCosign(memoryBoard(), 'secret')
    expect((await get(`${base}/cosign/cosign/wonderland/signatures`)).status).toBe(401)
    expect((await get(`${base}/cosign/cosign/wonderland/signatures`, { Authorization: 'Bearer secret' })).status).toBe(
      200,
    )
  })
})

it('without the cosign option, /cosign paths 404', async () => {
  const port = nextPort++
  const server = archiveServer({ archive: stubArchive() as never, port })
  open.add(server)
  const res = await get(`http://127.0.0.1:${port}/cosign/cosign/wonderland/signatures`)
  expect(res.status).toBe(404)
})
