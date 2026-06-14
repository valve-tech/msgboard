import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeRhinestoneOwnableAdapter,
  OWNABLE_VALIDATOR_ADDRESS,
  type OwnablePublicClient,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const validator = OWNABLE_VALIDATOR_ADDRESS
const account = '0x1111111111111111111111111111111111111111' as Hex
const rawHash = `0x${'77'.repeat(32)}` as Hex

const PK_A = `0x${'a'.repeat(64)}` as Hex
const PK_B = `0x${'b'.repeat(64)}` as Hex
const PK_C = `0x${'c'.repeat(64)}` as Hex
const ownerA = privateKeyToAccount(PK_A)
const ownerB = privateKeyToAccount(PK_B)
const ownerC = privateKeyToAccount(PK_C)

/** Fake client answering getOwners(account)/threshold(account) — asserts the account arg is passed. */
const fakeClient = (
  over?: Partial<Record<'getOwners' | 'threshold', unknown>>,
): OwnablePublicClient => ({
  readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    if (functionName === 'getOwners') {
      expect(args?.[0]).toBe(account) // keyed by the smart-account address
      return over?.getOwners ?? [ownerA.address, ownerB.address]
    }
    if (functionName === 'threshold') {
      expect(args?.[0]).toBe(account)
      return over?.threshold ?? 2n
    }
    throw new Error(`unexpected readContract: ${functionName}`)
  }),
})

const adapterOf = (client: OwnablePublicClient) =>
  makeRhinestoneOwnableAdapter({ publicClient: client, validator, account, chainId })

const rec = (o: Partial<SignatureRecord>): SignatureRecord => ({
  digest: rawHash,
  signer: ownerA.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta: '0x',
  ...o,
})

/** raw-hash signature (stateless / 1271 path): plain ECDSA over the raw hash, v∈{27,28}. */
const rawSig = async (pk: Hex) => serializeSignature(await sign({ hash: rawHash, privateKey: pk }))
/** 4337 signature: personal_sign over the raw userOpHash → recovers via toEthSignedMessageHash. */
const userOpSig = async (pk: Hex) => signMessage({ message: { raw: rawHash }, privateKey: pk })

describe('owners / threshold (keyed by account)', () => {
  it('owners() returns getOwners(account)', async () => {
    expect(await adapterOf(fakeClient()).owners!()).toEqual([ownerA.address, ownerB.address])
  })
  it('threshold() returns threshold(account) as a number', async () => {
    expect(await adapterOf(fakeClient()).threshold!()).toBe(2)
  })
})

describe('verify — raw-hash path (stateless / 1271)', () => {
  it('accepts a valid owner raw-hash signature', async () => {
    const r = rec({ signature: await rawSig(PK_A), signer: ownerA.address as Hex })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(true)
  })
  it('rejects a recovery != claimed signer', async () => {
    const r = rec({ signature: await rawSig(PK_A), signer: ownerB.address as Hex })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(false)
  })
  it('rejects a non-owner', async () => {
    const r = rec({ signature: await rawSig(PK_C), signer: ownerC.address as Hex })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(false)
  })
  it('rejects a wrong-digest signature', async () => {
    const wrong = serializeSignature(await sign({ hash: `0x${'00'.repeat(32)}` as Hex, privateKey: PK_A }))
    expect(await adapterOf(fakeClient()).verify(rec({ signature: wrong }))).toBe(false)
  })
})

describe('verify — 4337 userOp path (EIP-191-wrapped)', () => {
  it('accepts an owner signature over toEthSignedMessageHash(userOpHash)', async () => {
    const { encodeOwnableMeta } = await import('../../src/adapters/rhinestone.js')
    const meta = encodeOwnableMeta({
      mode: 1, hash: rawHash, packedUserOp: '0x', entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      validator, account, chainId,
    })
    const r = rec({ signature: await userOpSig(PK_A), signer: ownerA.address as Hex, meta })
    expect(await adapterOf(fakeClient()).verify(r)).toBe(true)
  })
  it('rejects a raw-signed signature presented as 4337 (prefix mismatch)', async () => {
    const { encodeOwnableMeta } = await import('../../src/adapters/rhinestone.js')
    const meta = encodeOwnableMeta({
      mode: 1, hash: rawHash, packedUserOp: '0x', entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      validator, account, chainId,
    })
    const r = rec({ signature: await rawSig(PK_A), signer: ownerA.address as Hex, meta }) // raw, not personal_sign
    expect(await adapterOf(fakeClient()).verify(r)).toBe(false)
  })
})

describe('verify — error propagation', () => {
  it('propagates an RPC error (does not swallow as false)', async () => {
    const client: OwnablePublicClient = { readContract: vi.fn(async () => { throw new Error('rpc down') }) }
    const r = rec({ signature: await rawSig(PK_A), signer: ownerA.address as Hex })
    await expect(adapterOf(client).verify(r)).rejects.toThrow('rpc down')
  })
})
