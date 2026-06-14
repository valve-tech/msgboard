import { describe, expect, it } from 'vitest'
import { type Hex, serializeSignature, size, slice, hexToNumber } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeSafeAdapter,
  buildSignatureBlob,
  buildExecTransactionArgs,
  type SafePublicClient,
  type SafeTx,
} from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex
const digest = `0x${'77'.repeat(32)}` as Hex

// Pick PKs whose addresses we can sort; we assert ascending by recovered address.
const PK_1 = `0x${'11'.repeat(32)}` as Hex
const PK_2 = `0x${'22'.repeat(32)}` as Hex
const PK_3 = `0x${'33'.repeat(32)}` as Hex
const acc1 = privateKeyToAccount(PK_1)
const acc2 = privateKeyToAccount(PK_2)
const acc3 = privateKeyToAccount(PK_3)
const allOwners = [acc1.address, acc2.address, acc3.address] as Hex[]

const fakeClient = (): SafePublicClient => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getOwners') return allOwners
    if (functionName === 'getThreshold') return 3n
    throw new Error(`unexpected: ${functionName}`)
  },
})

async function eip712Rec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: serializeSignature(await sign({ hash: digest, privateKey: pk })),
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
}

async function ethSignRec(pk: Hex, signer: Hex): Promise<SignatureRecord> {
  return {
    digest,
    signer,
    signature: await signMessage({ message: { raw: digest }, privateKey: pk }),
    scheme: SCHEME.ECDSA,
    meta: '0x',
  }
}

describe('order', () => {
  it('sorts records strictly ascending by signer address', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const recs = [
      await eip712Rec(PK_1, acc1.address as Hex),
      await eip712Rec(PK_2, acc2.address as Hex),
      await eip712Rec(PK_3, acc3.address as Hex),
    ]
    const shuffled = [recs[2], recs[0], recs[1]]
    const ordered = adapter.order(shuffled)
    const addrs = ordered.map((r) => BigInt(r.signer))
    for (let i = 1; i < addrs.length; i++) expect(addrs[i] > addrs[i - 1]).toBe(true)
  })

  it('dedups records with the same effective signer (keeps one)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const r = await eip712Rec(PK_1, acc1.address as Hex)
    const ordered = adapter.order([r, { ...r }])
    expect(ordered).toHaveLength(1)
  })
})

describe('buildSignatureBlob — EOA only', () => {
  it('concatenates one 65-byte word per signer in ascending order', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const recs = [
      await eip712Rec(PK_1, acc1.address as Hex),
      await eip712Rec(PK_2, acc2.address as Hex),
      await eip712Rec(PK_3, acc3.address as Hex),
    ]
    const ordered = adapter.order(recs)
    const blob = buildSignatureBlob(ordered)
    expect(size(blob)).toBe(3 * 65) // pure static region, no tails
    // Each word's v byte (last byte) is 27 or 28 for eip712.
    for (let i = 0; i < 3; i++) {
      const word = slice(blob, i * 65, i * 65 + 65)
      const v = hexToNumber(slice(word, 64, 65))
      expect(v === 27 || v === 28).toBe(true)
    }
  })

  it('sets v = original + 4 for ethSign records (Safe v>30 branch)', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const r = await ethSignRec(PK_1, acc1.address as Hex)
    const blob = buildSignatureBlob(adapter.order([r]))
    expect(size(blob)).toBe(65)
    const v = hexToNumber(slice(blob, 64, 65))
    expect(v === 31 || v === 32).toBe(true) // 27+4 or 28+4
  })

  it('preserves r and s from the original signature for eip712', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const r = await eip712Rec(PK_1, acc1.address as Hex)
    const blob = buildSignatureBlob(adapter.order([r]))
    // r||s (first 64 bytes) must equal the first 64 bytes of the raw signature.
    expect(slice(blob, 0, 64)).toBe(slice(r.signature, 0, 64))
  })
})

describe('buildExecTransactionArgs', () => {
  it('produces the positional execTransaction args with the blob as the last element', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const tx: SafeTx = {
      to: '0x2222222222222222222222222222222222222222',
      value: 5n,
      data: '0xabcd',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
    }
    const ordered = adapter.order([await eip712Rec(PK_1, acc1.address as Hex)])
    const blob = buildSignatureBlob(ordered)
    const args = buildExecTransactionArgs(ordered, tx)
    expect(args).toEqual([
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      blob,
    ])
  })
})
