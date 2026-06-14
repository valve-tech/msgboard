import { describe, expect, it } from 'vitest'
import { type Hex, hashTypedData, keccak256, encodeAbiParameters, slice } from 'viem'
import {
  type Safe4337UserOp,
  safe4337DomainSeparator,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  decodeSafe4337Meta,
  SAFE_OP_TYPEHASH,
  SAFE4337_DOMAIN_SEPARATOR_TYPEHASH,
} from '../../src/adapters/safe4337.js'
import { safeDomain } from '../../src/adapters/safe.js'

const module_ = '0x0000000000000000000000000000000000004337' as Hex
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex // canonical EntryPoint v0.7
const chainId = 369
const safe = '0x1111111111111111111111111111111111111111' as Hex

// helper: pack two uint128 into a bytes32 (high||low)
function pack128(high: bigint, low: bigint): Hex {
  const h = high.toString(16).padStart(32, '0')
  const l = low.toString(16).padStart(32, '0')
  return `0x${h}${l}` as Hex
}

const userOp: Safe4337UserOp = {
  sender: safe,
  nonce: 0n,
  initCode: '0x',
  callData: '0x7bb37428', // some executeUserOp selector + args (opaque here)
  accountGasLimits: pack128(100000n, 200000n), // verificationGasLimit=100000, callGasLimit=200000
  preVerificationGas: 21000n,
  gasFees: pack128(1_000_000_000n, 2_000_000_000n), // maxPriorityFeePerGas, maxFeePerGas
  paymasterAndData: '0x',
}
const validAfter = 0
const validUntil = 0

describe('SAFE_OP typehash constants (verified from Safe4337Module v0.3.0 source)', () => {
  it('pins the domain + SafeOp typehashes', () => {
    expect(SAFE4337_DOMAIN_SEPARATOR_TYPEHASH).toBe(
      '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218',
    )
    expect(SAFE_OP_TYPEHASH).toBe('0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f')
  })

  it('SAFE_OP_TYPEHASH equals keccak256 of its canonical type string', () => {
    const typeString =
      'SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)'
    expect(keccak256(new TextEncoder().encode(typeString))).toBe(SAFE_OP_TYPEHASH)
  })
})

describe('safe4337DomainSeparator (verifyingContract == the MODULE)', () => {
  it('equals keccak256(abi.encode(typehash, chainId, module))', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [SAFE4337_DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), module_],
      ),
    )
    expect(safe4337DomainSeparator(chainId, module_)).toBe(expected)
  })

  it('DIFFERS from the Safe adapter domain (module address != Safe address)', () => {
    expect(safe4337DomainSeparator(chainId, module_)).not.toBe(safeDomain(chainId, safe))
    // but using the module address in safeDomain yields the same separator (same typehash):
    expect(safe4337DomainSeparator(chainId, module_)).toBe(safeDomain(chainId, module_))
  })
})

describe('safe4337OperationDigest', () => {
  it('is deterministic', () => {
    const a = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    const b = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(a).toBe(b)
  })

  it('equals keccak256(safe4337OperationData(...))', () => {
    const data = safe4337OperationData(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)).toBe(keccak256(data))
  })

  it('equals the hand-built 0x19 0x01 domainSeparator safeOpStructHash pre-image hash', () => {
    const safeOpStructHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' }, // SAFE_OP_TYPEHASH
          { type: 'address' }, // safe
          { type: 'uint256' }, // nonce
          { type: 'bytes32' }, // keccak256(initCode)
          { type: 'bytes32' }, // keccak256(callData)
          { type: 'uint128' }, // verificationGasLimit
          { type: 'uint128' }, // callGasLimit
          { type: 'uint256' }, // preVerificationGas
          { type: 'uint128' }, // maxPriorityFeePerGas
          { type: 'uint128' }, // maxFeePerGas
          { type: 'bytes32' }, // keccak256(paymasterAndData)
          { type: 'uint48' }, // validAfter
          { type: 'uint48' }, // validUntil
          { type: 'address' }, // entryPoint
        ],
        [
          SAFE_OP_TYPEHASH,
          userOp.sender,
          userOp.nonce,
          keccak256(userOp.initCode),
          keccak256(userOp.callData),
          100000n, // unpackHigh128(accountGasLimits)
          200000n, // unpackLow128(accountGasLimits)
          userOp.preVerificationGas,
          1_000_000_000n, // unpackHigh128(gasFees)
          2_000_000_000n, // unpackLow128(gasFees)
          keccak256(userOp.paymasterAndData),
          validAfter,
          validUntil,
          entryPoint,
        ],
      ),
    )
    const domain = safe4337DomainSeparator(chainId, module_)
    const expected = keccak256(`0x1901${domain.slice(2)}${safeOpStructHash.slice(2)}` as Hex)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)).toBe(expected)
  })

  it('matches viem hashTypedData with the no-name/version domain (verifyingContract = module)', () => {
    const viemDigest = hashTypedData({
      domain: { chainId, verifyingContract: module_ },
      types: {
        SafeOp: [
          { name: 'safe', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'verificationGasLimit', type: 'uint128' },
          { name: 'callGasLimit', type: 'uint128' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'maxPriorityFeePerGas', type: 'uint128' },
          { name: 'maxFeePerGas', type: 'uint128' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validUntil', type: 'uint48' },
          { name: 'entryPoint', type: 'address' },
        ],
      },
      primaryType: 'SafeOp',
      message: {
        safe: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        verificationGasLimit: 100000n,
        callGasLimit: 200000n,
        preVerificationGas: userOp.preVerificationGas,
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 2_000_000_000n,
        paymasterAndData: userOp.paymasterAndData,
        validAfter,
        validUntil,
        entryPoint,
      },
    })
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)).toBe(viemDigest)
  })

  it('is sensitive to nonce, callData, module, entryPoint, chainId, and the validity window', () => {
    const base = safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(safe4337OperationDigest({ ...userOp, nonce: 1n }, module_, entryPoint, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest({ ...userOp, callData: '0xdead' }, module_, entryPoint, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, '0x0000000000000000000000000000000000009999' as Hex, entryPoint, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, '0x0000000000000000000000000000000000008888' as Hex, chainId, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, 1, validAfter, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, 1, validUntil)).not.toBe(base)
    expect(safe4337OperationDigest(userOp, module_, entryPoint, chainId, validAfter, 999)).not.toBe(base)
  })
})

describe('safe4337OperationData', () => {
  it('is 0x1901 ‖ 32-byte domainSeparator ‖ 32-byte structHash (66 bytes)', () => {
    const data = safe4337OperationData(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    expect(slice(data, 0, 2)).toBe('0x1901')
    expect(slice(data, 2, 34)).toBe(safe4337DomainSeparator(chainId, module_))
    // total length = 2 + 32 + 32 = 66 bytes
    expect((data.length - 2) / 2).toBe(66)
  })
})

describe('encodeSafe4337Meta / decodeSafe4337Meta', () => {
  it('round-trips userOp + module + entryPoint + chainId + window', () => {
    const meta = encodeSafe4337Meta(userOp, module_, entryPoint, chainId, validAfter, validUntil)
    const d = decodeSafe4337Meta(meta)
    expect(d.userOp).toEqual(userOp)
    expect(d.module).toBe(module_)
    expect(d.entryPoint).toBe(entryPoint)
    expect(d.chainId).toBe(chainId)
    expect(d.validAfter).toBe(validAfter)
    expect(d.validUntil).toBe(validUntil)
  })

  it('round-trips a rich userOp (non-empty initCode + paymasterAndData + non-zero window)', () => {
    const rich: Safe4337UserOp = {
      ...userOp,
      initCode: '0xabcdef',
      paymasterAndData: '0x1234567890',
      nonce: 42n,
    }
    const d = decodeSafe4337Meta(encodeSafe4337Meta(rich, module_, entryPoint, chainId, 100, 999))
    expect(d.userOp).toEqual(rich)
    expect(d.validAfter).toBe(100)
    expect(d.validUntil).toBe(999)
  })
})
