import type { Abi, Hex } from 'viem'
import type { Petition } from './descriptor.js'

/**
 * ABI for the on-chain PetitionSignatures contract. ORDER AND SHAPE ARE LAW — this
 * must match the deployed contract exactly:
 *   function submit(bytes32 petitionId, string statement, address signer, bytes signature)
 *   function submitBatch(bytes32 petitionId, string statement, address[] signers, bytes[] signatures)
 *   function signed(bytes32, address) view returns (bool)
 *   function count(bytes32) view returns (uint256)
 *   event Signed(bytes32 indexed petitionId, address indexed signer)
 */
export const PETITION_SIGNATURES_ABI = [
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'petitionId', type: 'bytes32' },
      { name: 'statement', type: 'string' },
      { name: 'signer', type: 'address' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submitBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'petitionId', type: 'bytes32' },
      { name: 'statement', type: 'string' },
      { name: 'signers', type: 'address[]' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'signed',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'bytes32' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'count',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Signed',
    inputs: [
      { name: 'petitionId', type: 'bytes32', indexed: true },
      { name: 'signer', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
] as const satisfies Abi

/** Builds the positional args for a `submit` call, in ABI arg order. */
export function buildSubmitArgs(
  p: Petition,
  signer: Hex,
  signature: Hex,
): readonly [Hex, string, Hex, Hex] {
  return [p.id, p.statement, signer, signature] as const
}

/** Builds the positional args for a `submitBatch` call, in ABI arg order. */
export function buildSubmitBatchArgs(
  p: Petition,
  signers: Hex[],
  signatures: Hex[],
): readonly [Hex, string, Hex[], Hex[]] {
  return [p.id, p.statement, signers, signatures] as const
}

/** A single chain's deployment record for the PetitionSignatures contract. */
export interface Deployment {
  chainId: number
  address: Hex
  deployBlock: number
}

/** Known deployments, keyed by chainId. Populated after the contract is deployed. */
export const deployments: Record<number, Deployment> = {
  // PulseChain V4 testnet (bots/demo). Deployed via valve_deployer 2026-07-28.
  943: { chainId: 943, address: '0x4e1c2e17fd4b9200654081a6f47a9b34ce498024', deployBlock: 24990403 },
}
