import {
  type Hex,
  encodeAbiParameters,
  decodeAbiParameters,
  hashTypedData,
  keccak256,
  slice,
  isAddressEqual,
} from 'viem'
import type { SignatureRecord } from '../record.js'
import { SCHEME } from '../record.js'
import type { CosignAdapter } from './adapter.js'
import {
  type SafePublicClient,
  recoverEffectiveSigner,
  verifyErc1271Against,
  makeSafeAdapter,
} from './safe.js'

/**
 * EntryPoint v0.7 PackedUserOperation — the subset of fields the SafeOp digest depends on.
 * `accountGasLimits` packs {uint128 verificationGasLimit}{uint128 callGasLimit} into bytes32;
 * `gasFees` packs {uint128 maxPriorityFeePerGas}{uint128 maxFeePerGas}. Matches UserOperationLib.
 */
export interface Safe4337UserOp {
  sender: Hex
  nonce: bigint
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: bigint
  gasFees: Hex
  paymasterAndData: Hex
}

/** keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") — same typehash as the Safe. */
export const SAFE4337_DOMAIN_SEPARATOR_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const

/**
 * keccak256("SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,
 * uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,
 * bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)")
 * — Safe4337Module v0.3.0.
 */
export const SAFE_OP_TYPEHASH =
  '0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f' as const

/** The viem typed-data `types` for a SafeOp (no EIP712Domain entry → no name/version in the domain). */
const SAFE_OP_TYPES = {
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
} as const

/** unpackHigh128 — the first 16 bytes of a packed bytes32 (verificationGasLimit / maxPriorityFeePerGas). */
function unpackHigh128(packed: Hex): bigint {
  return BigInt(slice(packed, 0, 16))
}

/** unpackLow128 — the last 16 bytes of a packed bytes32 (callGasLimit / maxFeePerGas). */
function unpackLow128(packed: Hex): bigint {
  return BigInt(slice(packed, 16, 32))
}

/**
 * The Safe4337Module domain separator. NO name, NO version — only chainId + verifyingContract,
 * where verifyingContract is the MODULE address (NOT the Safe). Equals the module's on-chain
 * `domainSeparator()`: keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, module)).
 */
export function safe4337DomainSeparator(chainId: number, module: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [SAFE4337_DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), module],
    ),
  )
}

/**
 * The SafeOp operation digest, computed locally. Byte-equal to the module's on-chain
 * `getOperationHash(userOp)` (asserted in the integration test). The canonical source at
 * runtime is the on-chain read; this local fn is for parity checks + offline digest building.
 */
export function safe4337OperationDigest(
  userOp: Safe4337UserOp,
  module: Hex,
  entryPoint: Hex,
  chainId: number,
  validAfter: number,
  validUntil: number,
): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: module },
    types: SAFE_OP_TYPES,
    primaryType: 'SafeOp',
    message: {
      safe: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      verificationGasLimit: unpackHigh128(userOp.accountGasLimits),
      callGasLimit: unpackLow128(userOp.accountGasLimits),
      preVerificationGas: userOp.preVerificationGas,
      maxPriorityFeePerGas: unpackHigh128(userOp.gasFees),
      maxFeePerGas: unpackLow128(userOp.gasFees),
      paymasterAndData: userOp.paymasterAndData,
      validAfter: BigInt(validAfter),
      validUntil: BigInt(validUntil),
      entryPoint,
    },
  })
}

/**
 * The module's `operationData` pre-image bytes: 0x19 ‖ 0x01 ‖ domainSeparator ‖ safeOpStructHash.
 * This is the `data` argument the module passes to a contract owner's isValidSignature(bytes,bytes)
 * (via the Safe's checkSignatures), and keccak256(data) === the operation digest. Used by the
 * erc1271 verify path. The structHash is computed exactly as the module's assembly keccak over the
 * 14 32-byte words (typehash + 13 SafeOp fields).
 */
export function safe4337OperationData(
  userOp: Safe4337UserOp,
  module: Hex,
  entryPoint: Hex,
  chainId: number,
  validAfter: number,
  validUntil: number,
): Hex {
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
        unpackHigh128(userOp.accountGasLimits),
        unpackLow128(userOp.accountGasLimits),
        userOp.preVerificationGas,
        unpackHigh128(userOp.gasFees),
        unpackLow128(userOp.gasFees),
        keccak256(userOp.paymasterAndData),
        BigInt(validAfter),
        BigInt(validUntil),
        entryPoint,
      ],
    ),
  )
  const domain = safe4337DomainSeparator(chainId, module)
  return `0x1901${domain.slice(2)}${safeOpStructHash.slice(2)}` as Hex
}

/** The ABI tuple for record.meta: the userOp fields + module + entryPoint + chainId + window. Order is law. */
const SAFE4337_META_ABI = [
  { name: 'sender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' },
  { name: 'paymasterAndData', type: 'bytes' },
  { name: 'module', type: 'address' },
  { name: 'entryPoint', type: 'address' },
  { name: 'chainId', type: 'uint256' },
  { name: 'validAfter', type: 'uint48' },
  { name: 'validUntil', type: 'uint48' },
] as const

/** ABI-encodes the userOp (+ module + entryPoint + chainId + window) for SignatureRecord.meta. */
export function encodeSafe4337Meta(
  userOp: Safe4337UserOp,
  module: Hex,
  entryPoint: Hex,
  chainId: number,
  validAfter: number,
  validUntil: number,
): Hex {
  return encodeAbiParameters(SAFE4337_META_ABI, [
    userOp.sender,
    userOp.nonce,
    userOp.initCode,
    userOp.callData,
    userOp.accountGasLimits,
    userOp.preVerificationGas,
    userOp.gasFees,
    userOp.paymasterAndData,
    module,
    entryPoint,
    BigInt(chainId),
    validAfter,
    validUntil,
  ])
}

/** Decodes record.meta back into the userOp + module + entryPoint + chainId + window. Throws on malformed input. */
export function decodeSafe4337Meta(meta: Hex): {
  userOp: Safe4337UserOp
  module: Hex
  entryPoint: Hex
  chainId: number
  validAfter: number
  validUntil: number
} {
  const [
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData,
    module,
    entryPoint,
    chainId,
    validAfter,
    validUntil,
  ] = decodeAbiParameters(SAFE4337_META_ABI, meta)
  return {
    userOp: {
      sender,
      nonce,
      initCode,
      callData,
      accountGasLimits,
      preVerificationGas,
      gasFees,
      paymasterAndData,
    },
    module,
    entryPoint,
    chainId: Number(chainId),
    validAfter: Number(validAfter),
    validUntil: Number(validUntil),
  }
}

/** Config for the Safe4337Module adapter. One instance is pinned to one (chainId, safe, module). */
export interface Safe4337AdapterConfig {
  publicClient: SafePublicClient
  /** The Safe (proxy) address — the userOp.sender; owners()/threshold() read THIS. */
  safe: Hex
  /** The Safe4337Module address — the EIP-712 verifyingContract for the operation digest. */
  module: Hex
  /** The chain id — binds the digest's domain. */
  chainId: number
}

/**
 * The concrete Safe4337Module CosignAdapter (module v0.3.0, EntryPoint v0.7). A thin variant of
 * the Safe adapter: owners/threshold read the Safe; the v-byte scheme, ascending order, EIP-1271
 * offset-tail blob, and deferral to the Safe's checkSignatures are identical — the ONLY difference
 * is the digest is the module's SafeOp operation hash, so verify recovers over THAT digest and the
 * 1271 path passes the SafeOp operationData pre-image. The userOp.signature framing (validity-window
 * prefix) is assembled by buildSafe4337Signature.
 */
export function makeSafe4337Adapter(config: Safe4337AdapterConfig): CosignAdapter {
  const { publicClient, safe } = config

  // owners()/threshold() read the SAFE. Reuse the Safe adapter (it is pinned to the Safe address);
  // its `order` is digest-agnostic, so we delegate to it too.
  const safeAdapter = makeSafeAdapter({ publicClient, safe, chainId: config.chainId })

  async function owners(): Promise<Hex[]> {
    return safeAdapter.owners!()
  }

  async function threshold(): Promise<number> {
    return safeAdapter.threshold!()
  }

  async function isOwner(addr: Hex): Promise<boolean> {
    const set = await owners()
    return set.some((o) => isAddressEqual(o, addr))
  }

  async function verify(record: SignatureRecord): Promise<boolean> {
    if (record.scheme === SCHEME.EIP1271) {
      return verifyErc1271(record)
    }
    // EOA paths: recover over the 4337 operation digest (recoverEffectiveSigner is digest-agnostic).
    let recovered: Hex
    try {
      recovered = await recoverEffectiveSigner(record)
    } catch {
      return false // malformed signature is "definitively invalid", not an infra error
    }
    if (!isAddressEqual(recovered, record.signer)) return false
    return isOwner(recovered)
  }

  async function verifyErc1271(record: SignatureRecord): Promise<boolean> {
    // Membership first (cheap; a non-owner can never count regardless of the 1271 result).
    if (!(await isOwner(record.signer))) return false
    // Rebuild the exact `data` pre-image the module passes to isValidSignature(bytes,bytes):
    // 0x19 ‖ 0x01 ‖ domainSeparator(module) ‖ safeOpStructHash, whose keccak256 == record.digest.
    const { userOp, module, entryPoint, chainId, validAfter, validUntil } = decodeSafe4337Meta(record.meta)
    const data = safe4337OperationData(userOp, module, entryPoint, chainId, validAfter, validUntil)
    return verifyErc1271Against(publicClient, record, data)
  }

  // order is digest-agnostic — delegate to the Safe adapter's strictly-ascending sort + dedup.
  function order(records: SignatureRecord[]): SignatureRecord[] {
    return safeAdapter.order(records)
  }

  return { verify, order, owners, threshold }
}
