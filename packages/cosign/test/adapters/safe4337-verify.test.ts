import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import type { SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  safe4337OperationDigest,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const validAfter = 0
const validUntil = 0

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}

const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428',
  accountGasLimits: pack128(100000n, 200000n),
  preVerificationGas: 21000n,
  gasFees: pack128(1n, 2n),
  paymasterAndData: '0x',
}
const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil)

const PK_A = `0x${'a'.repeat(64)}` as Hex
const PK_B = `0x${'b'.repeat(64)}` as Hex
const PK_C = `0x${'c'.repeat(64)}` as Hex
const ownerA = privateKeyToAccount(PK_A)
const ownerB = privateKeyToAccount(PK_B)
const ownerC = privateKeyToAccount(PK_C)

const fakeClient = (): SafePublicClient => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [ownerA.address, ownerB.address]
    if (functionName === 'getThreshold') return 2n
    throw new Error(`unexpected readContract: ${functionName}`)
  }),
})

const rec = (over: Partial<SignatureRecord>): SignatureRecord => ({
  digest,
  signer: ownerA.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta,
  ...over,
})

describe('makeSafe4337Adapter.owners / threshold (read the SAFE)', () => {
  it('owners() returns the Safe getOwners()', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.owners!()).toEqual([ownerA.address, ownerB.address])
  })

  it('threshold() returns the Safe getThreshold() as a number', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.threshold!()).toBe(2)
  })
})

describe('makeSafe4337Adapter.verify — eip712 over the 4337 operation digest', () => {
  it('accepts a valid owner EIP-712 signature over the op digest', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerA.address as Hex }))).toBe(true)
  })

  it('rejects when recovery != claimed signer', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerB.address as Hex }))).toBe(false)
  })

  it('rejects a non-owner signer', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_C }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerC.address as Hex }))).toBe(false)
  })

  it('rejects a signature over the wrong digest', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const wrong = serializeSignature(await sign({ hash: `0x${'00'.repeat(32)}` as Hex, privateKey: PK_A }))
    expect(await adapter.verify(rec({ scheme: SCHEME.EIP712, signature: wrong, signer: ownerA.address as Hex }))).toBe(false)
  })
})

describe('makeSafe4337Adapter.verify — ethSign (v>30) over the op digest', () => {
  it('accepts a valid owner eth_sign signature', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const signature = await signMessage({ message: { raw: digest }, privateKey: PK_B })
    expect(await adapter.verify(rec({ scheme: SCHEME.ECDSA, signature, signer: ownerB.address as Hex }))).toBe(true)
  })
})

describe('makeSafe4337Adapter.verify — error propagation', () => {
  it('propagates an RPC error from readContract', async () => {
    const client: SafePublicClient = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    const adapter = makeSafe4337Adapter({ publicClient: client, safe, module: module_, chainId })
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK_A }))
    await expect(
      adapter.verify(rec({ scheme: SCHEME.EIP712, signature, signer: ownerA.address as Hex })),
    ).rejects.toThrow('rpc down')
  })
})
