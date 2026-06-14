import { describe, expect, it, vi } from 'vitest'
import { type Hex, size, slice, hexToBigInt, getAddress, pad } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  makeSafeAdapter,
  buildSignatureBlob,
  EIP1271_MAGIC_VALUE,
  encodeSafeMeta,
  safeTransactionData,
  type SafePublicClient,
  type SafeTx,
} from '../../src/adapters/safe.js'

const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

const tx: SafeTx = {
  to: '0x2222222222222222222222222222222222222222',
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

// A contract owner (lowest address so it sorts first) + an EOA owner.
const contractOwner = '0x0000000000000000000000000000000000000abc' as Hex
const PK_EOA = `0x${'ee'.repeat(32)}` as Hex
const eoa = privateKeyToAccount(PK_EOA)
const digest = `0x${'77'.repeat(32)}` as Hex
const contractSig = '0xdeadbeefdeadbeef' as Hex // the 1271 dynamic tail bytes

const erc1271Rec: SignatureRecord = {
  digest,
  signer: contractOwner,
  signature: contractSig,
  scheme: SCHEME.EIP1271,
  meta: encodeSafeMeta(tx, safe, chainId),
}

/** Fake client: getOwners includes both; isValidSignature returns the magic (or not). */
const fakeClient = (magic: Hex = EIP1271_MAGIC_VALUE): SafePublicClient & { calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    readContract: vi.fn(async (args: { functionName: string; address: Hex }) => {
      calls.push(args)
      if (args.functionName === 'getOwners') return [contractOwner, eoa.address]
      if (args.functionName === 'getThreshold') return 2n
      if (args.functionName === 'isValidSignature') {
        // Must be called on the contract owner's address with (data, contractSignature).
        expect(getAddress(args.address)).toBe(getAddress(contractOwner))
        return magic
      }
      throw new Error(`unexpected: ${args.functionName}`)
    }),
  } as SafePublicClient & { calls: unknown[] }
}

describe('verify — erc1271 (v==0)', () => {
  it('accepts when isValidSignature(bytes,bytes) returns 0x20c13b0b', async () => {
    const client = fakeClient()
    const adapter = makeSafeAdapter({ publicClient: client, safe, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(true)
    // It must have queried isValidSignature with the full data pre-image (keccak == digest).
    const call = (client.readContract as unknown as { mock: { calls: { 0: { functionName: string; args: Hex[] } }[] } })
      .mock.calls.map((c) => c[0])
      .find((a: { functionName: string }) => a.functionName === 'isValidSignature') as
      | { args: [Hex, Hex] }
      | undefined
    expect(call).toBeTruthy()
    expect(call!.args[0]).toBe(safeTransactionData(tx, chainId, safe)) // _data = pre-image
    expect(call!.args[1]).toBe(contractSig) // _signature = contract tail
  })

  it('rejects when isValidSignature returns the wrong magic', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient('0x1626ba7e' as Hex), safe, chainId })
    expect(await adapter.verify(erc1271Rec)).toBe(false)
  })

  it('rejects an erc1271 record whose signer is not an owner', async () => {
    const adapter = makeSafeAdapter({ publicClient: fakeClient(), safe, chainId })
    const notOwner = { ...erc1271Rec, signer: '0x000000000000000000000000000000000000dEaD' as Hex }
    expect(await adapter.verify(notOwner)).toBe(false)
  })
})

describe('buildSignatureBlob — with an erc1271 tail', () => {
  it('lays out [static words] ‖ [tail] and back-patches s to the tail offset', () => {
    // One erc1271 word + one eip712 word; contractOwner < eoa so 1271 word is first.
    const eoaRec: SignatureRecord = {
      digest,
      signer: eoa.address as Hex,
      // deterministic EOA sig (any valid 65-byte sig — its bytes are copied verbatim)
      signature: ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as Hex, // r,s, v=27
      scheme: SCHEME.EIP712,
      meta: '0x',
    }
    // Caller passes ordered records (contractOwner first). buildSignatureBlob does the layout.
    const ordered = [erc1271Rec, eoaRec]
    const blob = buildSignatureBlob(ordered)

    const count = 2
    const staticLen = count * 65
    // Total = static + (32-byte length word + contractSig bytes).
    expect(size(blob)).toBe(staticLen + 32 + size(contractSig))

    // Word 0 (erc1271): r = left-padded contract owner; v = 0; s = offset = staticLen.
    const word0 = slice(blob, 0, 65)
    expect(slice(word0, 0, 32)).toBe(pad(contractOwner, { size: 32 }))
    const sOffset = hexToBigInt(slice(word0, 32, 64))
    expect(sOffset).toBe(BigInt(staticLen))
    expect(hexToBigInt(slice(word0, 64, 65))).toBe(0n) // v == 0

    // Word 1 (eip712): r||s||v copied verbatim, v == 27.
    const word1 = slice(blob, 65, 130)
    expect(slice(word1, 0, 64)).toBe(slice(eoaRec.signature, 0, 64))
    expect(hexToBigInt(slice(word1, 64, 65))).toBe(27n)

    // Dynamic tail at offset staticLen: {uint256 length}{contractSig}.
    const lengthWord = slice(blob, staticLen, staticLen + 32)
    expect(hexToBigInt(lengthWord)).toBe(BigInt(size(contractSig)))
    const tailSig = slice(blob, staticLen + 32, staticLen + 32 + size(contractSig))
    expect(tailSig).toBe(contractSig)
  })

  it('handles two erc1271 tails with cumulative offsets', () => {
    const owner2 = '0x0000000000000000000000000000000000000fff' as Hex
    const sig2 = '0xcafecafecafecafecafe' as Hex
    const rec2: SignatureRecord = {
      digest,
      signer: owner2,
      signature: sig2,
      scheme: SCHEME.EIP1271,
      meta: encodeSafeMeta(tx, safe, chainId),
    }
    // ordered ascending: contractOwner (0x…abc) < owner2 (0x…fff)
    const ordered = [erc1271Rec, rec2]
    const blob = buildSignatureBlob(ordered)
    const staticLen = 2 * 65

    // First tail at staticLen; its length = size(contractSig).
    const s0 = hexToBigInt(slice(slice(blob, 0, 65), 32, 64))
    expect(s0).toBe(BigInt(staticLen))
    // Second tail offset = staticLen + 32 + size(contractSig).
    const expectedSecondOffset = staticLen + 32 + size(contractSig)
    const s1 = hexToBigInt(slice(slice(blob, 65, 130), 32, 64))
    expect(s1).toBe(BigInt(expectedSecondOffset))

    // Verify the second tail bytes.
    const len1 = hexToBigInt(slice(blob, expectedSecondOffset, expectedSecondOffset + 32))
    expect(len1).toBe(BigInt(size(sig2)))
    expect(slice(blob, expectedSecondOffset + 32, expectedSecondOffset + 32 + size(sig2))).toBe(sig2)
  })
})
