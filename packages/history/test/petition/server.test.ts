import { afterEach, describe, expect, it } from 'vitest'
import { type Hex, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BoardClient, SignatureRecord } from '@msgboard/cosign'
import type { Content, RPCMessage } from '@msgboard/sdk'
import { type Petition, createPetition, signPetition } from '@msgboard/petition'
import { archiveServer, type ArchiveServer } from '../../src/server.js'

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}` as Hex
const NOW = new Date('2026-06-13T12:00:00.000Z')

/** A tiny in-memory board the petition SDK can post into and the route can read from. */
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

let nextPort = 35810
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

const startWithPetition = (board: BoardClient, token?: string) => {
  const port = nextPort++
  const server = archiveServer({
    archive: stubArchive() as never,
    port,
    token,
    petition: { board, boardRetentionDays: 30, now: () => NOW },
  })
  open.add(server)
  return { base: `http://127.0.0.1:${port}` }
}

const petition = (statement: string): Petition => ({
  id: `0x${'11'.repeat(32)}` as Hex,
  statement,
  creator: addr(1),
  createdAt: Math.floor(NOW.getTime() / 1000),
  chainId: 943,
  salt: `0x${'22'.repeat(32)}` as Hex,
})

describe('archiveServer with petition option (integration)', () => {
  it('post via the petition SDK → /petition/index returns it', async () => {
    const board = memoryBoard()
    const p = petition('build a park')
    await createPetition(board, p, NOW)

    const { base } = startWithPetition(board)
    const res = await get(`${base}/petition/index?days=7`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.petitions.map((x: Petition) => x.id)).toEqual([p.id])
  })

  it('sign then tally comes back through the route', async () => {
    const board = memoryBoard()
    const p = petition('fix the road')
    await createPetition(board, p, NOW)
    // A throwaway signer — signPetition recovers whoever signs, so any account works.
    const account = privateKeyToAccount(`0x${'33'.repeat(32)}` as Hex)
    const sign = (digest: Hex): Promise<Hex> => account.sign({ hash: digest })
    const record: SignatureRecord = await signPetition(
      board,
      p,
      addr(9), // verifyingContract — irrelevant for this route smoke test
      sign,
      NOW,
    )
    expect(record.signer).toBeTruthy()

    const { base } = startWithPetition(board)
    const res = await get(`${base}/petition/${p.id}/tally?days=7`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.signers).toEqual([record.signer.toLowerCase()])
  })

  it('unknown petition id → empty (no team-file gate, no 404)', async () => {
    const { base } = startWithPetition(memoryBoard())
    const res = await get(`${base}/petition/${`0x${'99'.repeat(32)}`}/tally`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(0)
  })

  it('shares /health and still serves /messages + /cosign 404s (unmounted)', async () => {
    const { base } = startWithPetition(memoryBoard())
    expect((await get(`${base}/health`)).status).toBe(200)
    expect((await get(`${base}/messages`)).status).toBe(200)
    expect((await get(`${base}/cosign/cosign/wonderland/signatures`)).status).toBe(404)
  })

  it('petition endpoints honor the bearer token', async () => {
    const { base } = startWithPetition(memoryBoard(), 'secret')
    expect((await get(`${base}/petition/index`)).status).toBe(401)
    expect((await get(`${base}/petition/index`, { Authorization: 'Bearer secret' })).status).toBe(
      200,
    )
  })
})

it('without the petition option, /petition paths 404', async () => {
  const port = nextPort++
  const server = archiveServer({ archive: stubArchive() as never, port })
  open.add(server)
  const res = await get(`http://127.0.0.1:${port}/petition/index`)
  expect(res.status).toBe(404)
})
