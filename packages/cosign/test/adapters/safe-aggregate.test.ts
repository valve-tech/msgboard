import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate } from '../../src/client.js'
import { makeSafeAdapter, buildSignatureBlob, type SafePublicClient } from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const digest = `0x${'77'.repeat(32)}` as Hex

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_X = `0x${'99'.repeat(32)}` as Hex // non-owner
const acc1 = privateKeyToAccount(PK_1)
const acc2 = privateKeyToAccount(PK_2)
const accX = privateKeyToAccount(PK_X)

const client: SafePublicClient = {
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [acc1.address, acc2.address]
    if (functionName === 'getThreshold') return 2n
    throw new Error(`unexpected: ${functionName}`)
  },
}

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

describe('aggregate(records, makeSafeAdapter(...))', () => {
  it('drops the non-owner, keeps owners, orders ascending, and yields a 2×65 blob', async () => {
    const adapter = makeSafeAdapter({ publicClient: client, safe, chainId })
    const records = [
      await rec(PK_2, acc2.address as Hex),
      await rec(PK_X, accX.address as Hex), // non-owner — filtered by verify
      await rec(PK_1, acc1.address as Hex),
    ]
    const ordered = await aggregate(records, adapter)
    expect(ordered).toHaveLength(2)
    // ascending by signer
    expect(BigInt(ordered[1].signer) > BigInt(ordered[0].signer)).toBe(true)
    // aggregate returns {signer, signature}[]; reconstruct records to build the blob.
    const orderedRecords = ordered.map((o) => records.find((r) => r.signer === o.signer)!)
    expect(size(buildSignatureBlob(orderedRecords))).toBe(2 * 65)
  })
})
