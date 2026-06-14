import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { splitSig, eoaWord, sortDedupBySigner } from '../../src/adapters/_ecdsa.js'
import { SCHEME, type SignatureRecord } from '../../src/record.js'

const digest = `0x${'77'.repeat(32)}` as Hex
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const a1 = privateKeyToAccount(PK_1)
const a2 = privateKeyToAccount(PK_2)
const a3 = privateKeyToAccount(PK_3)

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

describe('splitSig', () => {
  it('splits a 65-byte r||s||v word', async () => {
    const sig = serializeSignature(await sign({ hash: digest, privateKey: PK_1 }))
    const { r, s, v } = splitSig(sig)
    expect(size(r)).toBe(32)
    expect(size(s)).toBe(32)
    expect(v === 27 || v === 28).toBe(true)
    expect(slice(sig, 0, 32)).toBe(r)
    expect(slice(sig, 32, 64)).toBe(s)
  })

  it('throws on a non-65-byte signature', () => {
    expect(() => splitSig('0x1234' as Hex)).toThrow()
  })
})

describe('eoaWord', () => {
  it('returns the verbatim 65-byte {r}{s}{v} word (no v adjustment)', async () => {
    const sig = serializeSignature(await sign({ hash: digest, privateKey: PK_1 }))
    expect(eoaWord(sig)).toBe(sig) // verbatim
    expect(size(eoaWord(sig))).toBe(65)
  })
})

describe('sortDedupBySigner', () => {
  it('sorts strictly ascending by signer and dedups', async () => {
    const recs = [
      await rec(PK_3, a3.address as Hex),
      await rec(PK_1, a1.address as Hex),
      await rec(PK_2, a2.address as Hex),
      await rec(PK_1, a1.address as Hex), // dup signer
    ]
    const out = sortDedupBySigner(recs)
    expect(out).toHaveLength(3)
    const vals = out.map((r) => BigInt(r.signer))
    for (let i = 1; i < vals.length; i++) expect(vals[i] > vals[i - 1]).toBe(true)
  })
})
