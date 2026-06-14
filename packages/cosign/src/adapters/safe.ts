import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverAddress,
  recoverMessageAddress,
  isAddressEqual,
  getAddress,
  pad,
  concat,
  toHex,
  size,
  slice,
} from 'viem'
import type { SignatureRecord } from '../record.js'
import { SCHEME } from '../record.js'
import type { CosignAdapter } from './adapter.js'

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

/**
 * The minimal read-only client surface the adapter needs. A viem `PublicClient` satisfies it;
 * tests pass a fake with a stubbed `readContract`. Errors PROPAGATE (per cosign SDK §6).
 */
export interface SafePublicClient {
  readContract(args: {
    address: Hex
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

/** Config for the Safe adapter. One instance is pinned to one (chainId, safe). */
export interface SafeAdapterConfig {
  publicClient: SafePublicClient
  /** The Safe (proxy) address — also the EIP-712 verifyingContract. */
  safe: Hex
  /** The chain id — binds the digest's domain. */
  chainId: number
}

/** Minimal Safe ABI fragment — only the read functions the adapter calls. */
export const SAFE_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'isOwner',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getTransactionHash',
    stateMutability: 'view',
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
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const

/** The legacy EIP-1271 magic value: bytes4(keccak256("isValidSignature(bytes,bytes)")). */
export const EIP1271_MAGIC_VALUE = '0x20c13b0b' as const

/** ABI fragment for the LEGACY EIP-1271 interface Safe's checkNSignatures uses for v==0 owners. */
const ISIGNATURE_VALIDATOR_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: '_data', type: 'bytes' },
      { name: '_signature', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes4' }],
  },
] as const

/**
 * The effective signer address for a record under a given digest:
 * - EIP712: ecrecover over the digest.
 * - ECDSA (eth_sign): recover over the personal-message-prefixed digest.
 * - EIP1271: the record.signer (the contract owner) as-is.
 * Throws on a malformed signature (errors propagate).
 */
async function effectiveSigner(record: SignatureRecord): Promise<Hex> {
  if (record.scheme === SCHEME.EIP712) {
    return recoverAddress({ hash: record.digest, signature: record.signature })
  }
  if (record.scheme === SCHEME.ECDSA) {
    // eth_sign: viem applies "\x19Ethereum Signed Message:\n32" ‖ digest internally.
    return recoverMessageAddress({ message: { raw: record.digest }, signature: record.signature })
  }
  // EIP1271 contract owner.
  return getAddress(record.signer)
}

/**
 * The concrete Gnosis Safe CosignAdapter (v1.3.0 / v1.4.1). Verifies a single owner's
 * signature over the SafeTx digest per Safe's v-byte scheme + confirms membership, and
 * orders records into the strictly-ascending blob `checkNSignatures` accepts.
 */
export function makeSafeAdapter(config: SafeAdapterConfig): CosignAdapter {
  const { publicClient, safe } = config

  async function owners(): Promise<Hex[]> {
    const result = (await publicClient.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getOwners',
    })) as readonly Hex[]
    return result.map((a) => getAddress(a))
  }

  async function threshold(): Promise<number> {
    const result = (await publicClient.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
    })) as bigint
    return Number(result)
  }

  async function isOwner(addr: Hex): Promise<boolean> {
    const set = await owners()
    return set.some((o) => isAddressEqual(o, addr))
  }

  async function verify(record: SignatureRecord): Promise<boolean> {
    if (record.scheme === SCHEME.EIP1271) {
      return verifyErc1271(record)
    }
    // EOA paths: recover, require recovered === claimed signer, require membership.
    let recovered: Hex
    try {
      recovered = await effectiveSigner(record)
    } catch {
      return false // malformed signature is "definitively invalid", not an infra error
    }
    if (!isAddressEqual(recovered, record.signer)) return false
    return isOwner(recovered)
  }

  async function verifyErc1271(record: SignatureRecord): Promise<boolean> {
    // Membership first (cheap, and a non-owner can never count regardless of the 1271 result).
    if (!(await isOwner(record.signer))) return false
    // Rebuild the exact `data` pre-image Safe passes to isValidSignature(bytes,bytes):
    // 0x19 ‖ 0x01 ‖ domainSeparator ‖ safeTxHash, whose keccak256 == record.digest.
    const { safeTx, safe: metaSafe, chainId: metaChainId } = decodeSafeMeta(record.meta)
    const data = safeTransactionData(safeTx, metaChainId, metaSafe)
    const magic = (await publicClient.readContract({
      address: record.signer,
      abi: ISIGNATURE_VALIDATOR_ABI,
      functionName: 'isValidSignature',
      args: [data, record.signature],
    })) as Hex
    return magic.toLowerCase() === EIP1271_MAGIC_VALUE
  }

  function order(records: SignatureRecord[]): SignatureRecord[] {
    // Sort by record.signer, NOT by re-recovering: aggregate runs verify (which asserts
    // recovered === record.signer for EOA records) before order, so record.signer IS the
    // effective signer; for erc1271 records record.signer is the contract owner by definition.
    // This keeps order pure + synchronous, matching CosignAdapter.order (records) => records.
    const seen = new Set<string>()
    const deduped: SignatureRecord[] = []
    for (const r of records) {
      const key = getAddress(r.signer).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(r)
    }
    return deduped.sort((a, b) => {
      const av = BigInt(getAddress(a.signer))
      const bv = BigInt(getAddress(b.signer))
      return av < bv ? -1 : av > bv ? 1 : 0
    })
  }

  return { verify, order, owners, threshold }
}

/** Splits a 65-byte ECDSA signature into r (32) ‖ s (32) ‖ v (1). */
function splitSig(sig: Hex): { r: Hex; s: Hex; v: number } {
  if (size(sig) !== 65) throw new Error(`expected 65-byte signature, got ${size(sig)} bytes`)
  return { r: slice(sig, 0, 32), s: slice(sig, 32, 64), v: Number(BigInt(slice(sig, 64, 65))) }
}

/**
 * Builds the final `signatures` blob from records already in strictly-ascending order
 * (the output of `adapter.order`). EOA records contribute one 65-byte static word.
 * EIP-1271 records contribute a static word `{r=left-pad32(owner)}{s=offset}{v=0}` plus a
 * dynamic tail `{uint256 len}{contractSignature}`; the static `s` is back-patched to the tail's
 * byte offset from the start of the blob (Safe GS021–GS023 bounds, GS024 validity).
 */
export function buildSignatureBlob(ordered: SignatureRecord[]): Hex {
  const count = ordered.length
  const staticLen = count * 65
  const staticWords: Hex[] = []
  const tails: Hex[] = []
  let tailOffset = staticLen // first tail starts right after the static region

  for (const r of ordered) {
    if (r.scheme === SCHEME.EIP712) {
      const { r: sr, s: ss, v } = splitSig(r.signature)
      staticWords.push(concat([sr, ss, toHex(v, { size: 1 })]))
    } else if (r.scheme === SCHEME.ECDSA) {
      // eth_sign: Safe's v>30 branch does ecrecover(prefixed, v-4). Wallet gives v∈{27,28}, so +4.
      const { r: sr, s: ss, v } = splitSig(r.signature)
      staticWords.push(concat([sr, ss, toHex(v + 4, { size: 1 })]))
    } else {
      // EIP1271: r = left-padded owner, s = current tail offset, v = 0.
      // Safe reads r as address(uint160(uint256(r))) — case-insensitive; lowercase the
      // address bytes so the blob word is canonical/deterministic (not EIP-55 mixed case).
      const rField = pad(getAddress(r.signer).toLowerCase() as Hex, { size: 32 })
      const sField = toHex(BigInt(tailOffset), { size: 32 })
      staticWords.push(concat([rField, sField, toHex(0, { size: 1 })]))
      const lenWord = toHex(BigInt(size(r.signature)), { size: 32 })
      tails.push(concat([lenWord, r.signature]))
      tailOffset += 32 + size(r.signature)
    }
  }
  return concat([...staticWords, ...tails])
}

/**
 * Produces the positional arguments for `execTransaction(to, value, data, operation,
 * safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures)`. The caller submits.
 */
export function buildExecTransactionArgs(
  ordered: SignatureRecord[],
  safeTx: SafeTx,
): readonly [Hex, bigint, Hex, number, bigint, bigint, bigint, Hex, Hex, Hex] {
  return [
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    buildSignatureBlob(ordered),
  ]
}
