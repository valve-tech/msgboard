import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  hashTypedData,
  keccak256,
} from 'viem'

/**
 * The Safe transaction tuple that is EIP-712-signed and carried in SignatureRecord.meta.
 * Field order matches Safe's encodeTransactionData / SAFE_TX_TYPEHASH exactly.
 */
export interface SafeTx {
  to: Hex
  value: bigint
  data: Hex
  /** Enum.Operation: 0 = Call, 1 = DelegateCall. */
  operation: number
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: Hex
  refundReceiver: Hex
  nonce: bigint
}

/** keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") — Safe v1.4.1 (== v1.3.0). */
export const DOMAIN_SEPARATOR_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const

/**
 * keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,
 * uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")
 * — Safe v1.4.1 (== v1.3.0).
 */
export const SAFE_TX_TYPEHASH =
  '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8' as const

/** The viem typed-data `types` for a SafeTx (no EIP712Domain entry → no name/version in the domain). */
const SAFE_TX_TYPES = {
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

/**
 * The Safe EIP-712 domain separator. NO name, NO version — only chainId + verifyingContract.
 * Equals the on-chain `domainSeparator()`:
 *   keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, safe)).
 */
export function safeDomain(chainId: number, safe: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe],
    ),
  )
}

/**
 * The SafeTx EIP-712 digest, computed locally. Byte-equal to the Safe's on-chain
 * `getTransactionHash(...)` (asserted in the integration test). The canonical source at
 * runtime is the on-chain read; this local fn is for parity checks + offline digest building.
 */
export function safeTransactionDigest(safeTx: SafeTx, chainId: number, safe: Hex): Hex {
  return hashTypedData({
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
  })
}

/**
 * The `encodeTransactionData` pre-image bytes: 0x19 ‖ 0x01 ‖ domainSeparator ‖ safeTxHash.
 * This is the `data` argument Safe passes to a contract owner's isValidSignature(bytes,bytes),
 * and `keccak256(data) === digest` (Safe's GS027 check). Used by the erc1271 verify path.
 */
export function safeTransactionData(safeTx: SafeTx, chainId: number, safe: Hex): Hex {
  const safeTxHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        SAFE_TX_TYPEHASH,
        safeTx.to,
        safeTx.value,
        keccak256(safeTx.data),
        safeTx.operation,
        safeTx.safeTxGas,
        safeTx.baseGas,
        safeTx.gasPrice,
        safeTx.gasToken,
        safeTx.refundReceiver,
        safeTx.nonce,
      ],
    ),
  )
  const domain = safeDomain(chainId, safe)
  return `0x1901${domain.slice(2)}${safeTxHash.slice(2)}` as Hex
}

/** The ABI tuple for record.meta: the SafeTx fields + safe + chainId. Order is law. */
const SAFE_META_ABI = [
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
  { name: 'safe', type: 'address' },
  { name: 'chainId', type: 'uint256' },
] as const

/** ABI-encodes the SafeTx tuple (+ safe + chainId) for SignatureRecord.meta. */
export function encodeSafeMeta(safeTx: SafeTx, safe: Hex, chainId: number): Hex {
  return encodeAbiParameters(SAFE_META_ABI, [
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    safeTx.nonce,
    safe,
    BigInt(chainId),
  ])
}

/** Decodes record.meta back into the SafeTx tuple + safe + chainId. Throws on malformed input. */
export function decodeSafeMeta(meta: Hex): { safeTx: SafeTx; safe: Hex; chainId: number } {
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce, safe, chainId] =
    decodeAbiParameters(SAFE_META_ABI, meta)
  return {
    safeTx: {
      to,
      value,
      data,
      operation: Number(operation),
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce,
    },
    safe,
    chainId: Number(chainId),
  }
}
