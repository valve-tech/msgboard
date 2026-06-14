import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, concat, size } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
  OWNABLE_VALIDATOR_ADDRESS,
  type OwnablePublicClient,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const account = '0x1111111111111111111111111111111111111111' as Hex
const rawHash = `0x${'77'.repeat(32)}` as Hex
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_X = `0x${'ee'.repeat(32)}` as Hex // a non-owner
const a1 = privateKeyToAccount(PK_1)
const a2 = privateKeyToAccount(PK_2)
const ax = privateKeyToAccount(PK_X)

const client: OwnablePublicClient = {
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [a1.address, a2.address]
    if (functionName === 'threshold') return 2n
    throw new Error(`unexpected: ${functionName}`)
  },
}

async function rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest: rawHash,
    signer,
    signature: serializeSignature(await sign({ hash: rawHash, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

describe('aggregate + buildOwnableSignature', () => {
  it('keeps only owner sigs, orders them, and builds a 2-word blob', async () => {
    const adapter = makeRhinestoneOwnableAdapter({ publicClient: client, validator: OWNABLE_VALIDATOR_ADDRESS, account, chainId })
    const records = [
      await rec(PK_2, a2.address as Hex),
      await rec(PK_X, ax.address as Hex), // non-owner → dropped by verify
      await rec(PK_1, a1.address as Hex),
    ]
    const perDigest = groupByDigest(records).get(rawHash)!
    const pairs = await aggregate(perDigest, adapter)
    expect(pairs).toHaveLength(2) // the non-owner was filtered
    // ascending by signer
    expect(BigInt(pairs[1].signer) > BigInt(pairs[0].signer)).toBe(true)
    const orderedRecords = pairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const blob = buildOwnableSignature(orderedRecords)
    expect(size(blob)).toBe(130) // 2 × 65
    expect(blob).toBe(concat(orderedRecords.map((r) => r.signature)))
  })
})
