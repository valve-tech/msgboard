import { type Hex, type TypedDataDefinition, isAddressEqual, recoverAddress } from 'viem'
import { type SafeTx, safeTransactionDigest } from '@msgboard/cosign'

/**
 * The viem typed-data `types` for a Safe `SafeTx` (Safe v1.3.0 / v1.4.1). ORDER IS LAW and
 * mirrors @msgboard/cosign's internal SAFE_TX_TYPES — replicated here because the SDK does not
 * export the typed-data shape, only the resulting `safeTransactionDigest()`. We assert parity
 * by recovering against `safeTransactionDigest()` before any signature is posted, so a drift in
 * this table can never produce a record that the Safe adapter would later reject silently.
 *
 * No `EIP712Domain` entry → the domain carries only chainId + verifyingContract (no name/version),
 * exactly matching the Safe's on-chain `domainSeparator()`.
 */
export const SAFE_TX_TYPES = {
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
} as const

/** Builds the viem `signTypedData` definition for a SafeTx bound to (chainId, safe). */
export function safeTxTypedData(safeTx: SafeTx, chainId: number, safe: Hex): TypedDataDefinition {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    },
  }
}

/**
 * PARITY GUARDRAIL. Verifies that the EIP-712 signature just produced from the LOCAL `SAFE_TX_TYPES`
 * actually recovers to `expectedSigner` at the SDK's canonical `safeTransactionDigest(...)`. If the
 * local typed-data table ever drifts from the SDK's internal `SAFE_TX_TYPEHASH`, viem will have signed
 * a DIFFERENT hash and recovery at the SDK digest yields the wrong address — we THROW here so the drift
 * can never produce a record the Safe adapter would later reject. Call this BEFORE posting the share.
 * @throws if the recovered address does not match `expectedSigner`.
 */
export async function assertSafeTxSignatureParity(args: {
  safeTx: SafeTx
  chainId: number
  safe: Hex
  signature: Hex
  expectedSigner: Hex
}): Promise<Hex> {
  const digest = safeTransactionDigest(args.safeTx, args.chainId, args.safe)
  const recovered = await recoverAddress({ hash: digest, signature: args.signature })
  if (!isAddressEqual(recovered, args.expectedSigner)) {
    throw new Error(
      `Typed-data parity check FAILED: signature recovered to ${recovered} but expected ${args.expectedSigner}. ` +
        'The local SAFE_TX_TYPES has drifted from the SDK — refusing to post this share.',
    )
  }
  return digest
}

/** Minimal `execTransaction` ABI fragment for the (experimental) on-chain submit path. */
export const EXEC_TRANSACTION_ABI = [
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const
