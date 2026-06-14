import { describe, expect, it } from 'vitest'
import { type Hex, encodeAbiParameters, keccak256, getAddress } from 'viem'
import {
  type OwnableMeta,
  type PackedUserOp,
  userOpHash,
  encodeStatelessData,
  encodeOwnableMeta,
  decodeOwnableMeta,
  OWNABLE_VALIDATOR_ADDRESS,
} from '../../src/adapters/rhinestone.js'

const chainId = 1
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex // EntryPoint v0.7
const account = getAddress('0x1111111111111111111111111111111111111111') as Hex

const userOp: PackedUserOp = {
  sender: account,
  nonce: 0n,
  initCode: '0x',
  callData: '0xdeadbeef',
  accountGasLimits: `0x${'00'.repeat(32)}` as Hex,
  preVerificationGas: 0n,
  gasFees: `0x${'00'.repeat(32)}` as Hex,
  paymasterAndData: '0x',
  signature: '0x',
}

describe('userOpHash (ERC-4337 v0.7)', () => {
  it('is deterministic', () => {
    expect(userOpHash(userOp, entryPoint, chainId)).toBe(userOpHash(userOp, entryPoint, chainId))
  })

  it('equals keccak256(abi.encode(keccak256(packedFields), entryPoint, chainId))', () => {
    const hashedOp = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
          { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
        ],
        [
          userOp.sender, userOp.nonce, keccak256(userOp.initCode), keccak256(userOp.callData),
          userOp.accountGasLimits, userOp.preVerificationGas, userOp.gasFees, keccak256(userOp.paymasterAndData),
        ],
      ),
    )
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [hashedOp, entryPoint, BigInt(chainId)],
      ),
    )
    expect(userOpHash(userOp, entryPoint, chainId)).toBe(expected)
  })

  it('is sensitive to chainId, entryPoint, nonce, callData', () => {
    const base = userOpHash(userOp, entryPoint, chainId)
    expect(userOpHash(userOp, entryPoint, 10)).not.toBe(base)
    expect(userOpHash(userOp, getAddress('0x000000000000000000000000000000000000beef'), chainId)).not.toBe(base)
    expect(userOpHash({ ...userOp, nonce: 1n }, entryPoint, chainId)).not.toBe(base)
    expect(userOpHash({ ...userOp, callData: '0xfeed' }, entryPoint, chainId)).not.toBe(base)
  })
})

describe('encodeStatelessData', () => {
  it('abi.encodes (uint256 threshold, address[] owners) with owners sorted ascending', () => {
    const o1 = '0x0000000000000000000000000000000000000001' as Hex
    const o2 = '0x0000000000000000000000000000000000000002' as Hex
    // pass unsorted; encoder must emit sorted+deduped
    const data = encodeStatelessData(2, [o2, o1, o1])
    const expected = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address[]' }],
      [2n, [getAddress(o1), getAddress(o2)]],
    )
    expect(data).toBe(expected)
  })
})

describe('encodeOwnableMeta / decodeOwnableMeta', () => {
  it('round-trips a raw-hash (mode 0) record', () => {
    const meta: OwnableMeta = {
      mode: 0,
      hash: `0x${'ab'.repeat(32)}` as Hex,
      packedUserOp: '0x',
      entryPoint: getAddress('0x0000000000000000000000000000000000000000'),
      validator: OWNABLE_VALIDATOR_ADDRESS,
      account,
      chainId,
    }
    expect(decodeOwnableMeta(encodeOwnableMeta(meta))).toEqual(meta)
  })

  it('round-trips a 4337 (mode 1) record', () => {
    const meta: OwnableMeta = {
      mode: 1,
      hash: userOpHash(userOp, entryPoint, chainId),
      packedUserOp: '0xabcdef',
      entryPoint,
      validator: OWNABLE_VALIDATOR_ADDRESS,
      account,
      chainId,
    }
    expect(decodeOwnableMeta(encodeOwnableMeta(meta))).toEqual(meta)
  })
})
