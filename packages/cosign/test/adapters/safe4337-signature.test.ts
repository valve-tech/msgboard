import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice, hexToNumber } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { buildSignatureBlob, type SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  buildSafe4337Signature,
  safe4337OperationDigest,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

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

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const acc1 = privateKeyToAccount(PK_1)
const acc2 = privateKeyToAccount(PK_2)
const acc3 = privateKeyToAccount(PK_3)

const fakeClient = (): SafePublicClient => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return [acc1.address, acc2.address, acc3.address]
    if (functionName === 'getThreshold') return 3n
    throw new Error(`unexpected: ${functionName}`)
  },
})

async function eip712Rec(pk: Hex, signer: Hex, validAfter: number, validUntil: number): Promise<SignatureRecord> {
  const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil),
  }
}

describe('order delegates to the Safe adapter sort (ascending + dedup)', () => {
  it('sorts strictly ascending by signer and dedups', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const r1 = await eip712Rec(PK_1, acc1.address as Hex, 0, 0)
    const r2 = await eip712Rec(PK_2, acc2.address as Hex, 0, 0)
    const r3 = await eip712Rec(PK_3, acc3.address as Hex, 0, 0)
    const ordered = adapter.order([r3, r1, r2, { ...r1 }]) // includes a dup of r1
    expect(ordered).toHaveLength(3)
    for (let i = 1; i < ordered.length; i++) {
      expect(BigInt(ordered[i].signer) > BigInt(ordered[i - 1].signer)).toBe(true)
    }
  })
})

describe('buildSafe4337Signature', () => {
  it('prepends a 12-byte validity-window prefix (uint48 validAfter ‖ uint48 validUntil)', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const validAfter = 0x010203
    const validUntil = 0x0a0b0c
    const ordered = adapter.order([await eip712Rec(PK_1, acc1.address as Hex, validAfter, validUntil)])
    const sig = buildSafe4337Signature(ordered, validAfter, validUntil)
    // prefix: 6 bytes validAfter (big-endian uint48) ‖ 6 bytes validUntil
    expect(slice(sig, 0, 6)).toBe('0x000000010203')
    expect(slice(sig, 6, 12)).toBe('0x0000000a0b0c')
  })

  it('the body after the 12-byte prefix is EXACTLY the Safe adapter buildSignatureBlob (reuse, not duplicate)', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const ordered = adapter.order([
      await eip712Rec(PK_1, acc1.address as Hex, 0, 0),
      await eip712Rec(PK_2, acc2.address as Hex, 0, 0),
    ])
    const sig = buildSafe4337Signature(ordered, 0, 0)
    const expectedBlob = buildSignatureBlob(ordered)
    expect(slice(sig, 12)).toBe(expectedBlob)
    // total = 12-byte prefix + 2 * 65-byte words
    expect(size(sig)).toBe(12 + 2 * 65)
  })

  it('window of zero produces a 12-byte zero prefix', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    const ordered = adapter.order([await eip712Rec(PK_1, acc1.address as Hex, 0, 0)])
    const sig = buildSafe4337Signature(ordered, 0, 0)
    expect(slice(sig, 0, 12)).toBe('0x000000000000000000000000')
    // each ordered eip712 word ends in v 27/28
    const v = hexToNumber(slice(sig, 12 + 64, 12 + 65))
    expect(v === 27 || v === 28).toBe(true)
  })
})
