import { describe, expect, it, vi } from 'vitest'
import { type Hex, serializeSignature, getAddress } from 'viem'
import { privateKeyToAccount, sign, signMessage } from 'viem/accounts'
import { SCHEME, type SignatureRecord } from '../../src/record.js'
import {
  recoverEffectiveSigner,
  verifyErc1271Against,
  EIP1271_MAGIC_VALUE,
  type SafePublicClient,
} from '../../src/adapters/safe.js'

const digest = `0x${'77'.repeat(32)}` as Hex
const PK = `0x${'a'.repeat(64)}` as Hex
const acc = privateKeyToAccount(PK)

const rec = (over: Partial<SignatureRecord>): SignatureRecord => ({
  digest,
  signer: acc.address as Hex,
  signature: '0x',
  scheme: SCHEME.EIP712,
  meta: '0x',
  ...over,
})

describe('recoverEffectiveSigner (extracted EOA core — digest-agnostic)', () => {
  it('recovers an eip712 ECDSA signature over the digest', async () => {
    const signature = serializeSignature(await sign({ hash: digest, privateKey: PK }))
    const got = await recoverEffectiveSigner(rec({ scheme: SCHEME.EIP712, signature }))
    expect(getAddress(got)).toBe(getAddress(acc.address))
  })

  it('recovers an eth_sign (ECDSA) signature over the raw digest', async () => {
    const signature = await signMessage({ message: { raw: digest }, privateKey: PK })
    const got = await recoverEffectiveSigner(rec({ scheme: SCHEME.ECDSA, signature }))
    expect(getAddress(got)).toBe(getAddress(acc.address))
  })

  it('returns record.signer as-is for an EIP1271 record', async () => {
    const got = await recoverEffectiveSigner(rec({ scheme: SCHEME.EIP1271, signer: acc.address as Hex }))
    expect(getAddress(got)).toBe(getAddress(acc.address))
  })

  it('throws on a malformed signature (caller decides to map to false)', async () => {
    await expect(recoverEffectiveSigner(rec({ scheme: SCHEME.EIP712, signature: '0x1234' as Hex }))).rejects.toThrow()
  })
})

describe('verifyErc1271Against (extracted, injectable data pre-image)', () => {
  const owner = '0x0000000000000000000000000000000000000abc' as Hex
  const dataPreimage = ('0x1901' + 'ab'.repeat(32) + 'cd'.repeat(32)) as Hex
  const contractSig = '0xdeadbeef' as Hex

  const client = (magic: Hex): SafePublicClient =>
    ({
      readContract: vi.fn(async (args: { functionName: string; address: Hex; args?: readonly unknown[] }) => {
        if (args.functionName === 'isValidSignature') {
          expect(getAddress(args.address)).toBe(getAddress(owner))
          expect(args.args).toEqual([dataPreimage, contractSig]) // (bytes data, bytes signature)
          return magic
        }
        throw new Error(`unexpected: ${args.functionName}`)
      }),
    }) as SafePublicClient

  const record = (): SignatureRecord =>
    ({ digest, signer: owner, signature: contractSig, scheme: SCHEME.EIP1271, meta: '0x' })

  it('accepts when isValidSignature(bytes,bytes) returns 0x20c13b0b', async () => {
    expect(await verifyErc1271Against(client(EIP1271_MAGIC_VALUE), record(), dataPreimage)).toBe(true)
  })

  it('rejects on the wrong magic value', async () => {
    expect(await verifyErc1271Against(client('0x1626ba7e' as Hex), record(), dataPreimage)).toBe(false)
  })
})
