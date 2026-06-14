import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, getAddress } from 'viem'
import { privateKeyToAccount, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeRhinestoneOwnableAdapter,
  buildOwnableSignature,
  encodeStatelessData,
  encodeOwnableMeta,
  OWNABLE_VALIDATOR_ADDRESS,
  OWNABLE_VALIDATOR_ABI,
} from '../../src/adapters/rhinestone.js'
import { deployOwnableFixture, type OwnableFixture } from './_ownable-fixture.js'

// DEVIATION (real-API detail, verified on the canonical deployed bytecode):
// the plan's pinned source quote says validateSignatureWithData recovers over the RAW hash, with
// only validateUserOp applying the EIP-191 prefix. The CANONICAL DEPLOYED OwnableValidator at
// 0x2483DA3A338895199E5e538530213157e931Bf06 ALSO applies ECDSA.toEthSignedMessageHash(hash) inside
// validateSignatureWithData — probed directly: a raw `sign({hash})` word is rejected, a personal_sign
// `signMessage({message:{raw:hash}})` word is accepted. So this integration test uses the adapter's
// EIP-191 path (meta.mode = 1) whose verify (recoverMessageAddress) matches the on-chain recovery.

// A 2-of-3 owner set.
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const PK_X = `0x${'ee'.repeat(32)}` as Hex // non-owner
const owners = [PK_1, PK_2, PK_3].map((pk) => getAddress(privateKeyToAccount(pk).address)) as Hex[]
const threshold = 2

const hash = `0x${'a7'.repeat(32)}` as Hex // an arbitrary raw message hash
// The account is irrelevant for the stateless call but required by the adapter config; any address.
const account = '0x1111111111111111111111111111111111111111' as Hex

let fx: OwnableFixture | undefined
let anvilAvailable = true

beforeAll(async () => {
  try {
    fx = await deployOwnableFixture()
  } catch (err) {
    anvilAvailable = false
    // eslint-disable-next-line no-console
    console.warn('[rhinestone-integration] anvil/prool unavailable — skipping:', err)
  }
}, 60_000)

afterAll(async () => { await fx?.stop() })

// EIP-191 (mode 1) meta — the digest is the raw hash; the canonical validator prefixes it on-chain.
const mode1Meta = encodeOwnableMeta({
  mode: 1, hash, packedUserOp: '0x', entryPoint: getAddress('0x0000000000000000000000000000000000000000'),
  validator: OWNABLE_VALIDATOR_ADDRESS, account: getAddress(account), chainId: 1,
})

async function rawRec(pk: Hex): Promise<SignatureRecord> {
  return {
    digest: hash,
    signer: getAddress(privateKeyToAccount(pk).address),
    // personal_sign over the raw hash → recovers via toEthSignedMessageHash, matching the deployed
    // validator's validateSignatureWithData recovery (see DEVIATION note above).
    signature: await signMessage({ message: { raw: hash }, privateKey: pk }),
    scheme: SCHEME.EIP712,
    meta: mode1Meta,
  }
}

describe.runIf(() => anvilAvailable)('OwnableValidator integration (real validateSignatureWithData on anvil)', () => {
  it('a 2-of-3 board-aggregated blob is accepted (returns true)', async () => {
    const f = fx!
    // aggregate() calls adapter.verify → isOwner → owners(); install a tiny client returning our set.
    const ownersClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getOwners') return owners
        if (functionName === 'threshold') return BigInt(threshold)
        throw new Error(`unexpected: ${functionName}`)
      },
    }
    const adapter = makeRhinestoneOwnableAdapter({
      publicClient: ownersClient as never, validator: f.validator, account, chainId: f.chainId,
    })

    const records = [await rawRec(PK_1), await rawRec(PK_2)]
    const perDigest = groupByDigest(records).get(hash)!
    const pairs = await aggregate(perDigest, adapter)
    const orderedRecords = pairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const blob = buildOwnableSignature(orderedRecords)
    const data = encodeStatelessData(threshold, owners)

    const ok = (await f.publicClient.readContract({
      address: f.validator,
      abi: OWNABLE_VALIDATOR_ABI,
      functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(true)
  })

  it('a single signature (below threshold 2) is rejected', async () => {
    // DEVIATION: recoverNSignatures requires signatures.length >= threshold*65 and otherwise
    // reverts InvalidSignature() — so a below-threshold blob is rejected by REVERT, not a false
    // return. The plan expected `false`; the real validator reverts. Either way it is not accepted.
    const f = fx!
    const blob = buildOwnableSignature([await rawRec(PK_1)]) // only 1 word, threshold 2
    const data = encodeStatelessData(threshold, owners)
    await expect(
      f.publicClient.readContract({
        address: f.validator, abi: OWNABLE_VALIDATOR_ABI, functionName: 'validateSignatureWithData',
        args: [hash, blob, data],
      }),
    ).rejects.toThrow()
  })

  it('a non-owner co-signer does not count toward threshold (false)', async () => {
    const f = fx!
    // one real owner + one non-owner; sorted blob of 2 words, but only 1 is an owner → < threshold
    const recs = [await rawRec(PK_1), await rawRec(PK_X)]
    const sorted = recs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
    const blob = buildOwnableSignature(sorted)
    const data = encodeStatelessData(threshold, owners)
    const ok = (await f.publicClient.readContract({
      address: f.validator, abi: OWNABLE_VALIDATOR_ABI, functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(false)
  })

  it('unsorted owners in data are rejected by isSortedAndUniquified (false)', async () => {
    const f = fx!
    const blob = buildOwnableSignature([await rawRec(PK_1), await rawRec(PK_2)].sort(
      (a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1),
    ))
    // hand-build an UNSORTED owners array (bypass encodeStatelessData's sort) via raw abi encoding
    const { encodeAbiParameters } = await import('viem')
    const unsorted = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)) // descending
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address[]' }],
      [BigInt(threshold), unsorted],
    )
    const ok = (await f.publicClient.readContract({
      address: f.validator, abi: OWNABLE_VALIDATOR_ABI, functionName: 'validateSignatureWithData',
      args: [hash, blob, data],
    })) as boolean
    expect(ok).toBe(false)
  })
})
