import { describe, expect, it, vi } from 'vitest'
import { type Hex, getAddress } from 'viem'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { EIP1271_MAGIC_VALUE, type SafePublicClient } from '../../src/adapters/safe.js'
import {
  makeSafe4337Adapter,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const validAfter = 0
const validUntil = 0
const contractOwner = '0x0000000000000000000000000000000000000abc' as Hex
const contractSig = '0xdeadbeefdeadbeef' as Hex

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

const erc1271Rec: SignatureRecord = {
  digest,
  signer: contractOwner,
  signature: contractSig,
  scheme: SCHEME.EIP1271,
  meta,
}

const fakeClient = (magic: Hex = EIP1271_MAGIC_VALUE): SafePublicClient => ({
  readContract: vi.fn(async (args: { functionName: string; address: Hex; args?: readonly unknown[] }) => {
    if (args.functionName === 'getOwners') return [contractOwner, '0x000000000000000000000000000000000000bEEF']
    if (args.functionName === 'getThreshold') return 2n
    if (args.functionName === 'isValidSignature') {
      expect(getAddress(args.address)).toBe(getAddress(contractOwner))
      // The module passes the 4337 operationData pre-image (NOT a Safe-tx pre-image).
      expect(args.args).toEqual([safe4337OperationData(userOp, module_, entryPoint, chainId, validAfter, validUntil), contractSig])
      return magic
    }
    throw new Error(`unexpected: ${args.functionName}`)
  }),
})

describe('makeSafe4337Adapter.verify — erc1271 (v==0) over the 4337 operationData', () => {
  it('accepts when isValidSignature(bytes,bytes) returns 0x20c13b0b', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(true)
  })

  it('rejects on the wrong magic', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient('0x1626ba7e' as Hex), safe, module: module_, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(false)
  })

  it('rejects an erc1271 record whose signer is not an owner', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: fakeClient(), safe, module: module_, chainId })
    expect(await adapter.verify({ ...erc1271Rec, signer: '0x000000000000000000000000000000000000dEaD' as Hex })).toBe(false)
  })
})
