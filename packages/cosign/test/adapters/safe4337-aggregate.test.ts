import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate } from '../../src/client.js'
import { type SafePublicClient } from '../../src/adapters/safe.js'
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
const digest = safe4337OperationDigest(userOp, module_, entryPoint, chainId, 0, 0)
const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, 0, 0)

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_X = `0x${'99'.repeat(32)}` as Hex
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
    meta,
  }
}

describe('aggregate(records, makeSafe4337Adapter(...))', () => {
  it('drops the non-owner, orders ascending, and yields a window-prefixed 2×65 signature', async () => {
    const adapter = makeSafe4337Adapter({ publicClient: client, safe, module: module_, chainId })
    const records = [
      await rec(PK_2, acc2.address as Hex),
      await rec(PK_X, accX.address as Hex), // non-owner — filtered by verify
      await rec(PK_1, acc1.address as Hex),
    ]
    const ordered = await aggregate(records, adapter)
    expect(ordered).toHaveLength(2)
    expect(BigInt(ordered[1].signer) > BigInt(ordered[0].signer)).toBe(true)
    const orderedRecords = ordered.map((o) => records.find((r) => r.signer === o.signer)!)
    const sig = buildSafe4337Signature(orderedRecords, 0, 0)
    expect(slice(sig, 0, 12)).toBe('0x000000000000000000000000') // zero window
    expect(size(sig)).toBe(12 + 2 * 65)
  })
})
