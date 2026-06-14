import { describe, expect, it } from 'vitest'
import { type Hex, hashTypedData, keccak256, encodeAbiParameters } from 'viem'
import {
  type SafeTx,
  safeDomain,
  safeTransactionDigest,
  encodeSafeMeta,
  decodeSafeMeta,
  SAFE_TX_TYPEHASH,
  DOMAIN_SEPARATOR_TYPEHASH,
} from '../../src/adapters/safe.js'

const safe = '0x1111111111111111111111111111111111111111' as Hex
const chainId = 369

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

describe('SAFE typehash constants (verified from Safe v1.4.1 source)', () => {
  it('pins the domain + SafeTx typehashes', () => {
    expect(DOMAIN_SEPARATOR_TYPEHASH).toBe(
      '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218',
    )
    expect(SAFE_TX_TYPEHASH).toBe(
      '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8',
    )
  })

  it('the typehashes equal keccak256 of their canonical type strings', () => {
    expect(keccak256(new TextEncoder().encode('EIP712Domain(uint256 chainId,address verifyingContract)'))).toBe(
      DOMAIN_SEPARATOR_TYPEHASH,
    )
    expect(
      keccak256(
        new TextEncoder().encode(
          'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
        ),
      ),
    ).toBe(SAFE_TX_TYPEHASH)
  })
})

describe('safeDomain', () => {
  it('equals the on-chain domainSeparator pre-image (no name/version)', () => {
    // domainSeparator() = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, this))
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe],
      ),
    )
    expect(safeDomain(chainId, safe)).toBe(expected)
  })
})

describe('safeTransactionDigest', () => {
  it('is deterministic', () => {
    expect(safeTransactionDigest(tx, chainId, safe)).toBe(safeTransactionDigest(tx, chainId, safe))
  })

  it('equals the hand-built 0x19 0x01 domainSeparator safeTxHash pre-image hash', () => {
    const safeTxHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' }, // SAFE_TX_TYPEHASH
          { type: 'address' }, // to
          { type: 'uint256' }, // value
          { type: 'bytes32' }, // keccak256(data)
          { type: 'uint8' }, // operation
          { type: 'uint256' }, // safeTxGas
          { type: 'uint256' }, // baseGas
          { type: 'uint256' }, // gasPrice
          { type: 'address' }, // gasToken
          { type: 'address' }, // refundReceiver
          { type: 'uint256' }, // nonce
        ],
        [
          SAFE_TX_TYPEHASH,
          tx.to,
          tx.value,
          keccak256(tx.data),
          tx.operation,
          tx.safeTxGas,
          tx.baseGas,
          tx.gasPrice,
          tx.gasToken,
          tx.refundReceiver,
          tx.nonce,
        ],
      ),
    )
    const domain = safeDomain(chainId, safe)
    const expected = keccak256(`0x1901${domain.slice(2)}${safeTxHash.slice(2)}` as Hex)
    expect(safeTransactionDigest(tx, chainId, safe)).toBe(expected)
  })

  it('matches viem hashTypedData with the no-name/version domain', () => {
    const viemDigest = hashTypedData({
      domain: { chainId, verifyingContract: safe },
      types: {
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'SafeTx',
      message: { ...tx },
    })
    expect(safeTransactionDigest(tx, chainId, safe)).toBe(viemDigest)
  })

  it('is sensitive to chainId, safe, and nonce', () => {
    const base = safeTransactionDigest(tx, chainId, safe)
    expect(safeTransactionDigest(tx, 1, safe)).not.toBe(base)
    expect(safeTransactionDigest(tx, chainId, '0x3333333333333333333333333333333333333333')).not.toBe(base)
    expect(safeTransactionDigest({ ...tx, nonce: 1n }, chainId, safe)).not.toBe(base)
  })

  it('is sensitive to non-empty data', () => {
    expect(safeTransactionDigest({ ...tx, data: '0xdeadbeef' }, chainId, safe)).not.toBe(
      safeTransactionDigest(tx, chainId, safe),
    )
  })
})

describe('encodeSafeMeta / decodeSafeMeta', () => {
  it('round-trips the SafeTx tuple + safe + chainId', () => {
    const meta = encodeSafeMeta(tx, safe, chainId)
    const decoded = decodeSafeMeta(meta)
    expect(decoded.safe).toBe(safe)
    expect(decoded.chainId).toBe(chainId)
    expect(decoded.safeTx).toEqual(tx)
  })

  it('round-trips a tx with non-empty data + non-zero gas fields', () => {
    const rich: SafeTx = {
      ...tx,
      data: '0xabcdef',
      value: 123n,
      operation: 1,
      safeTxGas: 21000n,
      baseGas: 5000n,
      gasPrice: 7n,
      gasToken: '0x4444444444444444444444444444444444444444',
      refundReceiver: '0x5555555555555555555555555555555555555555',
      nonce: 9n,
    }
    expect(decodeSafeMeta(encodeSafeMeta(rich, safe, chainId)).safeTx).toEqual(rich)
  })
})
