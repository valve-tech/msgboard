import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { makeSafeAdapter, type SafePublicClient } from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const digest = `0x${'77'.repeat(32)}` as Hex

// Three deterministic EOAs; ownerA/ownerB are owners, ownerC is NOT.
const PK_A = `0x${'a'.repeat(64)}` as Hex
const PK_B = `0x${'b'.repeat(64)}` as Hex
const PK_C = `0x${'c'.repeat(64)}` as Hex
const ownerA = privateKeyToAccount(PK_A)
const ownerB = privateKeyToAccount(PK_B)
const ownerC = privateKeyToAccount(PK_C)

/** A fake PublicClient whose readContract answers getOwners/getThreshold for OUR Safe. */
const fakeClient = (over?: Partial<Record<'getOwners' | 'getThreshold', unknown>>): SafePublicClient => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return over?.getOwners ?? [ownerA.address, ownerB.address]
    if (functionName === 'getThreshold') return over?.getThreshold ?? 2n
    throw new Error(`unexpected readContract: ${functionName}`)
  }),
})

const rec = (overrides: Partial<SignatureRecord>): SignatureRecord => ({
  digest,
  signer: ownerA.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta: '0x',
  ...overrides,
})

/** A raw EIP-712-style ECDSA signature over `digest` (v ∈ {27,28}). */
async function eip712Sig(pk: Hex): Promise<Hex> {
  return serializeSignature(await sign({ hash: digest, privateKey: pk }))
}

/** An eth_sign-style signature: personal_sign over the raw 32-byte digest (v ∈ {27,28}). */
async function ethSignSig(pk: Hex): Promise<Hex> {
  return signMessage({ message: { raw: digest }, privateKey: pk })
}

describe('makeSafeAdapter.owners / threshold', () => {
  it('owners() returns getOwners()', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    expect(await adapter.owners!()).toEqual([ownerA.address, ownerB.address])
  })

  it('threshold() returns getThreshold() as a number', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    expect(await adapter.threshold!()).toBe(2)
  })
})

describe('makeSafeAdapter.verify — eip712 (v 27/28 ECDSA)', () => {
  it('accepts a valid owner EIP-712 signature', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await eip712Sig(PK_A)
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerA.address as Hex }))).toBe(
      true,
    )
  })

  it('rejects a signature whose recovery != claimed signer', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await eip712Sig(PK_A) // signed by A …
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerB.address as Hex }))).toBe(
      false, // … but claims B
    )
  })

  it('rejects a non-owner signer (valid sig, not in owner set)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await eip712Sig(PK_C)
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerC.address as Hex }))).toBe(
      false,
    )
  })

  it('rejects a signature over the wrong digest', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const wrong = serializeSignature(await sign({ hash: `0x${'00'.repeat(32)}` as Hex, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: wrong, signer: ownerA.address as Hex }))).toBe(
      false,
    )
  })
})

describe('makeSafeAdapter.verify — ethSign (v > 30)', () => {
  it('accepts a valid owner eth_sign signature (scheme ECDSA)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await ethSignSig(PK_B)
    expect(await adapter.verify(rec({ scheme: SCHEME.ECDSA, signature: sig, signer: ownerB.address as Hex }))).toBe(
      true,
    )
  })

  it('rejects an eth_sign signature from a non-owner', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const sig = await ethSignSig(PK_C)
    expect(await adapter.verify(rec({ scheme: SCHEME.ECDSA, signature: sig, signer: ownerC.address as Hex }))).toBe(
      false,
    )
  })
})

describe('makeSafeAdapter.verify — error propagation', () => {
  it('propagates an RPC error from readContract (does not swallow as false)', async () => {
    const client: SafePublicClient = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    const adapter = makeSafeAdapter({ publicClient: client, safe, chainId })
    const sig = await eip712Sig(PK_A)
    await expect(
      adapter.verify(rec({ scheme: SCHEME.EIP712, signature: sig, signer: ownerA.address as Hex })),
    ).rejects.toThrow('rpc down')
  })
})
