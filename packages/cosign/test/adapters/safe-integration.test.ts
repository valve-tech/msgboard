import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, parseAbi, getAddress, serializeSignature } from 'viem'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import { aggregate, groupByDigest } from '../../src/client.js'
import {
  makeSafeAdapter,
  buildSignatureBlob,
  buildExecTransactionArgs,
  safeTransactionDigest,
  encodeSafeMeta,
  type SafeTx,
} from '../../src/adapters/safe.js'
import { sign, privateKeyToAccount } from 'viem/accounts'
import { deploySafeFixture, type SafeFixture } from './_safe-fixture.js'

const SAFE_READ_ABI = parseAbi([
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function checkSignatures(bytes32 dataHash, bytes data, bytes signatures) view',
  'function nonce() view returns (uint256)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
])

// Three owners; 2-of-3.
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex

let fx: SafeFixture | undefined
let anvilAvailable = true

beforeAll(async () => {
  try {
    fx = await deploySafeFixture([PK_1, PK_2, PK_3], 2)
  } catch (err) {
    anvilAvailable = false
    // eslint-disable-next-line no-console
    console.warn('[safe-integration] anvil/prool unavailable — skipping integration test:', err)
  }
}, 60_000)

afterAll(async () => {
  await fx?.stop()
})

describe.runIf(() => anvilAvailable)('Safe v1.4.1 integration (real checkNSignatures + execTransaction)', () => {
  it('local digest equals on-chain getTransactionHash', async () => {
    const f = fx!
    const tx: SafeTx = {
      to: getAddress('0x000000000000000000000000000000000000dEaD'),
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
    }
    const onChain = (await f.publicClient.readContract({
      address: f.safe,
      abi: SAFE_READ_ABI,
      functionName: 'getTransactionHash',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
    })) as Hex
    expect(safeTransactionDigest(tx, f.chainId, f.safe)).toBe(onChain)
  })

  it('aggregated blob is accepted by checkSignatures and execTransaction succeeds', async () => {
    const f = fx!
    const tx: SafeTx = {
      to: getAddress('0x000000000000000000000000000000000000dEaD'),
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
    }
    const digest = safeTransactionDigest(tx, f.chainId, f.safe)
    const meta = encodeSafeMeta(tx, f.safe, f.chainId)

    // two of the three owners sign (EIP-712 over the digest)
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

    const adapter = makeSafeAdapter({ publicClient: f.publicClient as never, safe: f.safe, chainId: f.chainId })

    // sanity: adapter reads match the deployed Safe
    expect((await adapter.owners!()).length).toBe(3)
    expect(await adapter.threshold!()).toBe(2)

    const perDigest = groupByDigest(records).get(digest)!
    const orderedPairs = await aggregate(perDigest, adapter)
    const orderedRecords = orderedPairs.map((p) => perDigest.find((r) => r.signer === p.signer)!)
    const blob = buildSignatureBlob(orderedRecords)

    // 1) checkSignatures must not revert. For an all-EOA blob `data` is unused by Safe
    //    (it only checks keccak(data)==dataHash when a v==0 word is present), so pass 0x.
    await expect(
      f.publicClient.readContract({
        address: f.safe,
        abi: SAFE_READ_ABI,
        functionName: 'checkSignatures',
        args: [digest, '0x', blob],
      }),
    ).resolves.toBeUndefined()

    // 2) execTransaction succeeds
    const args = buildExecTransactionArgs(orderedRecords, tx)
    const hash = await f.walletClient.writeContract({
      address: f.safe,
      abi: SAFE_READ_ABI,
      functionName: 'execTransaction',
      account: f.walletClient.account!,
      chain: f.walletClient.chain,
      args: args as never,
    })
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')

    // 3) nonce incremented
    const nonceAfter = (await f.publicClient.readContract({
      address: f.safe,
      abi: SAFE_READ_ABI,
      functionName: 'nonce',
    })) as bigint
    expect(nonceAfter).toBe(1n)
  })

  it('a wrong-order blob reverts with GS026', async () => {
    const f = fx!
    const tx: SafeTx = {
      to: getAddress('0x000000000000000000000000000000000000dEaD'),
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 1n, // nonce advanced by the prior test
    }
    const digest = safeTransactionDigest(tx, f.chainId, f.safe)
    const meta = encodeSafeMeta(tx, f.safe, f.chainId)
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
    const adapter = makeSafeAdapter({ publicClient: f.publicClient as never, safe: f.safe, chainId: f.chainId })
    const ordered = adapter.order(recs)
    // deliberately reverse to violate strictly-ascending
    const blob = buildSignatureBlob([...ordered].reverse())
    await expect(
      f.publicClient.readContract({
        address: f.safe,
        abi: SAFE_READ_ABI,
        functionName: 'checkSignatures',
        args: [digest, '0x', blob],
      }),
    ).rejects.toThrow(/GS026/)
  })
})
