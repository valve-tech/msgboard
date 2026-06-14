import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice, concat } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
  OWNABLE_VALIDATOR_ADDRESS,
  type OwnablePublicClient,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const validator = OWNABLE_VALIDATOR_ADDRESS
const account = '0x1111111111111111111111111111111111111111' as Hex
const rawHash = `0x${'77'.repeat(32)}` as Hex

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const a1 = privateKeyToAccount(PK_1)
const a2 = privateKeyToAccount(PK_2)
const a3 = privateKeyToAccount(PK_3)
const allOwners = [a1.address, a2.address, a3.address] as Hex[]

const fakeClient = (): OwnablePublicClient => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return allOwners
    if (functionName === 'threshold') return 2n
    throw new Error(`unexpected: ${functionName}`)
  },
})

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest: rawHash,
    signer,
    signature: serializeSignature(await sign({ hash: rawHash, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

const adapter = () => makeRhinestoneOwnableAdapter({ publicClient: fakeClient(), validator, account, chainId })

describe('order', () => {
  it('sorts strictly ascending by signer + dedups', async () => {
    const r1 = await rec(PK_1, a1.address as Hex)
    const r2 = await rec(PK_2, a2.address as Hex)
    const r3 = await rec(PK_3, a3.address as Hex)
    const out = adapter().order([r3, r1, r2, { ...r1 }])
    expect(out).toHaveLength(3)
    const vals = out.map((r) => BigInt(r.signer))
    for (let i = 1; i < vals.length; i++) expect(vals[i] > vals[i - 1]).toBe(true)
  })
})

describe('buildOwnableSignature', () => {
  it('concatenates one verbatim 65-byte word per signer in order (no v+4, no tail)', async () => {
    const r1 = await rec(PK_1, a1.address as Hex)
    const r2 = await rec(PK_2, a2.address as Hex)
    const ordered = adapter().order([r2, r1])
    const blob = buildOwnableSignature(ordered)
    expect(size(blob)).toBe(ordered.length * 65)
    // each 65-byte slice is the verbatim signature of the corresponding ordered record
    for (let i = 0; i < ordered.length; i++) {
      expect(slice(blob, i * 65, (i + 1) * 65)).toBe(ordered[i].signature)
    }
    expect(blob).toBe(concat(ordered.map((r) => r.signature)))
  })
})
