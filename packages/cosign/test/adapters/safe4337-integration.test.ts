import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, parseAbi, getAddress, slice } from 'viem'
import { serializeSignature, sign, privateKeyToAccount } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeSafe4337Adapter,
  buildSafe4337Signature,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  type Safe4337UserOp,
} from '../../src/adapters/safe4337.js'
import { deploySafe4337Fixture, type Safe4337Fixture } from './_safe4337-fixture.js'

const MODULE_ABI = parseAbi([
  'function getOperationHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)',
])
const SAFE_CHECK_ABI = parseAbi([
  'function checkSignatures(bytes32 dataHash, bytes data, bytes signatures) view',
])

const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex

function pack128(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, '0')}${low.toString(16).padStart(32, '0')}` as Hex
}

let fx: Safe4337Fixture | undefined
let anvilAvailable = true

beforeAll(async () => {
  try {
    fx = await deploySafe4337Fixture([PK_1, PK_2, PK_3], 2)
  } catch (err) {
    anvilAvailable = false
    // eslint-disable-next-line no-console
    console.warn('[safe4337-integration] anvil/prool/module-artifact unavailable — skipping:', err)
  }
}, 90_000)

afterAll(async () => {
  await fx?.stop()
})

describe.runIf(() => anvilAvailable)(
  'Safe4337Module v0.3.0 integration (real getOperationHash + checkSignatures)',
  () => {
    function makeUserOp(f: Safe4337Fixture): Safe4337UserOp {
      return {
        sender: f.safe,
        nonce: 0n,
        initCode: '0x',
        // executeUserOp(address,uint256,bytes,uint8) selector + a no-op call to 0xdead
        callData: '0x7bb37428000000000000000000000000000000000000000000000000000000000000dEaD' as Hex,
        accountGasLimits: pack128(100000n, 200000n),
        preVerificationGas: 21000n,
        gasFees: pack128(1n, 2n),
        paymasterAndData: '0x',
      }
    }

    it('local op digest equals on-chain module.getOperationHash', async () => {
      const f = fx!
      const userOp = makeUserOp(f)
      const validAfter = 0
      const validUntil = 0
      const local = safe4337OperationDigest(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)
      // For getOperationHash the module reads validAfter/validUntil from userOp.signature[0:12].
      const sigForHash = `0x${'00'.repeat(12)}` as Hex // window = 0,0; signatures empty is fine for the hash read
      const onChain = (await f.publicClient.readContract({
        address: f.module,
        abi: MODULE_ABI,
        functionName: 'getOperationHash',
        args: [
          {
            sender: userOp.sender,
            nonce: userOp.nonce,
            initCode: userOp.initCode,
            callData: userOp.callData,
            accountGasLimits: userOp.accountGasLimits,
            preVerificationGas: userOp.preVerificationGas,
            gasFees: userOp.gasFees,
            paymasterAndData: userOp.paymasterAndData,
            signature: sigForHash,
          },
        ],
      })) as Hex
      expect(local).toBe(onChain)
    })

    it('aggregated blob is accepted by the Safe checkSignatures over the operationData', async () => {
      const f = fx!
      const userOp = makeUserOp(f)
      const validAfter = 0
      const validUntil = 0
      const digest = safe4337OperationDigest(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)
      const meta = encodeSafe4337Meta(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)

      const records: SignatureRecord[] = []
      for (const pk of [PK_1, PK_2]) {
        records.push({
          digest,
          signer: getAddress(privateKeyToAccount(pk).address),
          signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
          scheme: SCHEME.EIP712,
          meta,
        })
      }

      const adapter = makeSafe4337Adapter({
        publicClient: f.publicClient as never,
        safe: f.safe,
        module: f.module,
        chainId: f.chainId,
      })
      expect((await adapter.owners!()).length).toBe(3)
      expect(await adapter.threshold!()).toBe(2)

      const perDigest = groupByDigest(records).get(digest)!
      const orderedPairs = await aggregate(perDigest, adapter)
      const orderedRecords = orderedPairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
      const fullSig = buildSafe4337Signature(orderedRecords, validAfter, validUntil)
      const signatures = slice(fullSig, 12) // strip the 12-byte window prefix (what the module forwards)

      // operationData is the pre-image; the module computes keccak256(operationData) == digest.
      const operationData = safe4337OperationData(userOp, f.module, f.entryPoint, f.chainId, validAfter, validUntil)

      await expect(
        f.publicClient.readContract({
          address: f.safe,
          abi: SAFE_CHECK_ABI,
          functionName: 'checkSignatures',
          args: [digest, operationData, signatures],
        }),
      ).resolves.toBeUndefined()
    })

    it('a wrong-order blob reverts with GS026', async () => {
      const f = fx!
      const userOp = makeUserOp(f)
      const digest = safe4337OperationDigest(userOp, f.module, f.entryPoint, f.chainId, 0, 0)
      const meta = encodeSafe4337Meta(userOp, f.module, f.entryPoint, f.chainId, 0, 0)
      const recs: SignatureRecord[] = []
      for (const pk of [PK_1, PK_2]) {
        recs.push({
          digest,
          signer: getAddress(privateKeyToAccount(pk).address),
          signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
          scheme: SCHEME.EIP712,
          meta,
        })
      }
      const adapter = makeSafe4337Adapter({
        publicClient: f.publicClient as never,
        safe: f.safe,
        module: f.module,
        chainId: f.chainId,
      })
      const ordered = adapter.order(recs)
      const fullSig = buildSafe4337Signature([...ordered].reverse(), 0, 0) // violate ascending
      const signatures = slice(fullSig, 12)
      const operationData = safe4337OperationData(userOp, f.module, f.entryPoint, f.chainId, 0, 0)
      await expect(
        f.publicClient.readContract({
          address: f.safe,
          abi: SAFE_CHECK_ABI,
          functionName: 'checkSignatures',
          args: [digest, operationData, signatures],
        }),
      ).rejects.toThrow(/GS026/)
    })
  },
)
