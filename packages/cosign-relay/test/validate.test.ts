import { describe, expect, it } from 'vitest'
import { type Hex, encodeAbiParameters, encodeFunctionData, keccak256, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount, signMessage } from 'viem/accounts'
import { SAFE_SETUP_ABI, SAFE_V141 } from '../src/constants.js'
import {
  assertPlainSafeSetup,
  decodeSafeSetup,
  recoverRequestSigner,
  requestDigest,
  type SafeSetup,
} from '../src/validate.js'

const OWNER_A = '0x1111111111111111111111111111111111111111' as const
const OWNER_B = '0x2222222222222222222222222222222222222222' as const

/** Builds a Safe `setup` initializer, defaulting to a plain (relay-eligible) multisig. */
function buildSetup(overrides: Partial<{
  owners: Hex[]
  threshold: bigint
  to: Hex
  data: Hex
  fallbackHandler: Hex
  paymentToken: Hex
  payment: bigint
  paymentReceiver: Hex
}> = {}): Hex {
  const owners = overrides.owners ?? [OWNER_A, OWNER_B]
  const threshold = overrides.threshold ?? 1n
  const to = overrides.to ?? zeroAddress
  const data = overrides.data ?? '0x'
  const fallbackHandler = overrides.fallbackHandler ?? SAFE_V141.fallbackHandler
  const paymentToken = overrides.paymentToken ?? zeroAddress
  const payment = overrides.payment ?? 0n
  const paymentReceiver = overrides.paymentReceiver ?? zeroAddress
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver],
  })
}

describe('decodeSafeSetup', () => {
  it('decodes a plain setup call', () => {
    const decoded = decodeSafeSetup(buildSetup())
    expect(decoded.owners).toEqual([OWNER_A, OWNER_B])
    expect(decoded.threshold).toBe(1n)
    expect(decoded.to).toBe(zeroAddress)
    expect(decoded.data).toBe('0x')
    expect(decoded.fallbackHandler.toLowerCase()).toBe(SAFE_V141.fallbackHandler.toLowerCase())
    expect(decoded.paymentToken).toBe(zeroAddress)
    expect(decoded.payment).toBe(0n)
    expect(decoded.paymentReceiver).toBe(zeroAddress)
  })

  it('throws on non-setup calldata', () => {
    const notSetup = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'ping',
          stateMutability: 'nonpayable',
          inputs: [],
          outputs: [],
        },
      ] as const,
      functionName: 'ping',
      args: [],
    })
    expect(() => decodeSafeSetup(notSetup)).toThrow()
  })

  it('throws on garbage calldata', () => {
    expect(() => decodeSafeSetup('0xdeadbeef')).toThrow()
  })
})

describe('assertPlainSafeSetup', () => {
  const plain = (): SafeSetup => decodeSafeSetup(buildSetup())

  it('accepts a plain setup (single owner, threshold 1)', () => {
    const decoded = decodeSafeSetup(buildSetup({ owners: [OWNER_A], threshold: 1n }))
    expect(() => assertPlainSafeSetup(decoded)).not.toThrow()
  })

  it('accepts a plain setup (two owners, threshold 1)', () => {
    expect(() => assertPlainSafeSetup(plain())).not.toThrow()
  })

  it('rejects a non-zero `to`', () => {
    const decoded = decodeSafeSetup(buildSetup({ to: OWNER_A }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects non-empty `data`', () => {
    const decoded = decodeSafeSetup(buildSetup({ data: '0x1234' }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects the wrong fallback handler', () => {
    const decoded = decodeSafeSetup(buildSetup({ fallbackHandler: OWNER_A }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('accepts the canonical fallback handler case-insensitively', () => {
    const decoded = decodeSafeSetup(buildSetup({ fallbackHandler: SAFE_V141.fallbackHandler.toLowerCase() as Hex }))
    expect(() => assertPlainSafeSetup(decoded)).not.toThrow()
  })

  it('rejects a non-zero payment token', () => {
    const decoded = decodeSafeSetup(buildSetup({ paymentToken: OWNER_A }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects a non-zero payment', () => {
    const decoded = decodeSafeSetup(buildSetup({ payment: 1n }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects a non-zero payment receiver', () => {
    const decoded = decodeSafeSetup(buildSetup({ paymentReceiver: OWNER_A }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects threshold 0', () => {
    const decoded = decodeSafeSetup(buildSetup({ threshold: 0n }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects threshold > owners.length', () => {
    const decoded = decodeSafeSetup(buildSetup({ owners: [OWNER_A], threshold: 2n }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects duplicate owners (case-insensitive)', () => {
    const decoded = decodeSafeSetup(buildSetup({ owners: [OWNER_A, OWNER_A.toUpperCase().replace('0X', '0x') as Hex] }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })

  it('rejects an empty owners list', () => {
    const decoded = decodeSafeSetup(buildSetup({ owners: [] }))
    expect(() => assertPlainSafeSetup(decoded)).toThrow()
  })
})

describe('requestDigest', () => {
  const initializer = buildSetup()

  it('round-trips deterministically for the same inputs', () => {
    const a = requestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })
    const b = requestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })
    expect(a).toBe(b)
  })

  it('matches a hand-computed keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
        [943n, SAFE_V141.singletonL2, keccak256(initializer), 1n],
      ),
    )
    expect(requestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })).toBe(expected)
  })

  it('changes when any input changes', () => {
    const base = requestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })
    expect(requestDigest({ chainId: 369, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })).not.toBe(base)
    expect(requestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 2n })).not.toBe(base)
  })
})

describe('recoverRequestSigner', () => {
  const initializer = buildSetup()
  const digest = requestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })

  it('recovers the owner that signed the digest', async () => {
    const ownerKey = generatePrivateKey()
    const account = privateKeyToAccount(ownerKey)
    const signature = await signMessage({ privateKey: ownerKey, message: { raw: digest } })
    const recovered = await recoverRequestSigner(digest, signature)
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('recovers a DIFFERENT address for a signature from a different key (so the server can reject a non-owner)', async () => {
    const signerKey = generatePrivateKey()
    const otherKey = generatePrivateKey()
    const signature = await signMessage({ privateKey: signerKey, message: { raw: digest } })
    const recovered = await recoverRequestSigner(digest, signature)
    const otherAccount = privateKeyToAccount(otherKey)
    expect(recovered.toLowerCase()).not.toBe(otherAccount.address.toLowerCase())
  })

  it('a signature from a non-owner recovers to an address not in owners[]', async () => {
    const nonOwnerKey = generatePrivateKey()
    const signature = await signMessage({ privateKey: nonOwnerKey, message: { raw: digest } })
    const recovered = await recoverRequestSigner(digest, signature)
    const decoded = decodeSafeSetup(initializer)
    expect(decoded.owners.some((o: Hex) => o.toLowerCase() === recovered.toLowerCase())).toBe(false)
  })
})
