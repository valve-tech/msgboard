import { describe, expect, it } from 'vitest'
import { type Hex, keccak256 } from 'viem'
import type { Content, RPCMessage } from '@msgboard/sdk'
import { SCHEME, type SignatureRecord, encodeRecord } from '../src/record.js'
import { categoryKey, keysForWindow } from '../src/keys.js'
import {
  type BoardClient,
  aggregate,
  groupByDigest,
  postSignature,
  readSignatures,
} from '../src/client.js'
import type { CosignAdapter } from '../src/adapters/adapter.js'

const signer = (n: string): Hex => `0x${n.repeat(40).slice(0, 40)}` as Hex
const digestA = `0x${'aa'.repeat(32)}` as Hex
const digestB = `0x${'bb'.repeat(32)}` as Hex
const sig = `0x${'33'.repeat(65)}` as Hex

const rec = (digest: Hex, signerAddr: Hex): SignatureRecord => ({
  digest,
  signer: signerAddr,
  signature: sig,
  scheme: SCHEME.ECDSA,
  meta: '0x',
})

/** Builds a single RPCMessage carrying `data` (only the `data` field matters here). */
const msg = (data: Hex): RPCMessage => ({ data } as RPCMessage)

describe('postSignature', () => {
  it('encodes the record and adds it under the current UTC day key', async () => {
    const calls: { category: Hex; data: Hex }[] = []
    const board: BoardClient = {
      addMessage: async (arg) => {
        calls.push(arg)
        return '0xhash'
      },
      content: async () => ({}),
    }
    const now = new Date('2026-06-13T10:00:00.000Z')
    const record = rec(digestA, signer('1'))
    await postSignature(board, { namespace: 'cosign', scope: 'acme', record, now })
    expect(calls).toHaveLength(1)
    expect(calls[0].category).toBe(categoryKey('cosign', 'acme', '2026-06-13'))
    expect(calls[0].data).toBe(encodeRecord(record))
  })
})

describe('readSignatures', () => {
  it('sweeps the window, decodes, skips junk, and dedupes by data', async () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    const [k0, k1] = keysForWindow('cosign', 'acme', 2, now)
    const r1 = rec(digestA, signer('1'))
    const r2 = rec(digestB, signer('2'))
    const requested: Hex[] = []
    const board: BoardClient = {
      addMessage: async () => '0x',
      content: async ({ category }) => {
        requested.push(category)
        if (category === k0) {
          return {
            [k0]: [
              msg(encodeRecord(r1)),
              msg('0xdeadbeef' as Hex), // junk — must be skipped, not throw
              msg(encodeRecord(r1)), // duplicate of r1 — deduped by data
            ],
          } as Content
        }
        return { [k1]: [msg(encodeRecord(r2))] } as Content
      },
    }
    const out = await readSignatures(board, { namespace: 'cosign', scope: 'acme', days: 2, now })
    expect(requested).toEqual([k0, k1]) // both window categories queried
    expect(out).toHaveLength(2) // r1 (once), r2 — junk skipped, dup removed
    expect(out.map((r) => r.signer).sort()).toEqual([signer('1'), signer('2')].sort())
  })
})

describe('groupByDigest', () => {
  it('groups records by their digest', () => {
    const records = [rec(digestA, signer('1')), rec(digestA, signer('2')), rec(digestB, signer('3'))]
    const groups = groupByDigest(records)
    expect(groups.get(digestA)?.map((r) => r.signer)).toEqual([signer('1'), signer('2')])
    expect(groups.get(digestB)?.map((r) => r.signer)).toEqual([signer('3')])
    expect([...groups.keys()].sort()).toEqual([digestA, digestB].sort())
  })
})

describe('aggregate', () => {
  it('keeps records the adapter verifies, then applies its order', async () => {
    const r1 = rec(digestA, signer('1'))
    const r2 = rec(digestA, signer('2'))
    const r3 = rec(digestA, signer('3'))
    // adapter rejects r2, and orders by signer descending
    const adapter: CosignAdapter = {
      verify: async (record) => record.signer !== signer('2'),
      order: (records) => [...records].sort((a, b) => (a.signer < b.signer ? 1 : -1)),
    }
    const out = await aggregate([r1, r2, r3], adapter)
    expect(out).toEqual([
      { signer: signer('3'), signature: sig },
      { signer: signer('1'), signature: sig },
    ])
  })

  it('propagates adapter.verify errors (does not swallow as invalid)', async () => {
    const adapter: CosignAdapter = {
      verify: async () => {
        throw new Error('rpc down')
      },
      order: (records) => records,
    }
    await expect(aggregate([rec(digestA, signer('1'))], adapter)).rejects.toThrow('rpc down')
  })

  it('dedupes by keccak256 of the message data field', () => {
    // sanity: same record encodes identically, so its data-hash collides
    const r = rec(digestA, signer('1'))
    expect(keccak256(encodeRecord(r))).toBe(keccak256(encodeRecord(r)))
  })
})
