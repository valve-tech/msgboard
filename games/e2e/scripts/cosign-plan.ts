/**
 * Pure, network-free logic for the cosign bot — the parts worth pinning with unit tests.
 *
 * Everything here is a deterministic function of its inputs: Safe v1.4.1 deterministic-address
 * prediction (so a restart re-derives the SAME Safe and the human sees a stable session), the
 * benign no-op SafeTx the bot proposes each session, the fleet's deterministic saltNonce, the
 * relay's deploy-request digest + PoW (mirrored bit-for-bit from `packages/cosign-relay`), and the
 * session-state fold (which owners have signed a digest → is the quorum met).
 *
 * The Safe constants + prediction are replicated from `packages/cosign-web/src/lib/deploy-safe.ts`
 * and the relay PoW from `.../lib/gasless.ts` — those live in the WEB app (not an importable
 * package export), so we copy the canonical values here under test. The fixed fixtures in the
 * sibling test lock the copy to the real 369/943 v1.4.1 factory output.
 */
import {
  type Hex,
  concat,
  encodeFunctionData,
  encodeAbiParameters,
  getContractAddress,
  isAddressEqual,
  keccak256,
  pad,
  toBytes,
  toHex,
  zeroAddress,
} from 'viem'
import type { SafeTx } from '@msgboard/cosign'

/** Canonical Safe v1.4.1 deterministic-deployment addresses (L2 singleton). */
export const SAFE_V141 = {
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
} as const satisfies Record<string, Hex>

/** Minimal SafeProxyFactory ABI — createProxyWithNonce + the ProxyCreation event we confirm against. */
export const PROXY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
  {
    type: 'event',
    name: 'ProxyCreation',
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'singleton', type: 'address', indexed: false },
    ],
  },
] as const

const SAFE_SETUP_ABI = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const

/** The Safe `setup` initializer for a plain owners+threshold multisig (no module/guard/payment). */
export function buildSetup(owners: Hex[], threshold: number): Hex {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [owners, BigInt(threshold), zeroAddress, '0x', SAFE_V141.fallbackHandler, zeroAddress, 0n, zeroAddress],
  })
}

/**
 * The Safe v1.4.1 SafeProxy creation code (from SafeProxyFactory.proxyCreationCode()).
 * keccak256 == 0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f. Embedded so
 * address prediction is a pure, synchronous function; locked by the fixed-fixture test.
 */
export const PROXY_CREATION_CODE_V141: Hex =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564'

/** Deterministic CREATE2 address for a v1.4.1 Safe with these params. Pure + synchronous. */
export function predictSafeAddress(args: { owners: Hex[]; threshold: number; saltNonce: bigint }): Hex {
  const initializer = buildSetup(args.owners, args.threshold)
  const salt = keccak256(concat([keccak256(initializer), pad(toHex(args.saltNonce), { size: 32 })]))
  const deploymentData = concat([PROXY_CREATION_CODE_V141, pad(SAFE_V141.singletonL2, { size: 32 })])
  return getContractAddress({ opcode: 'CREATE2', from: SAFE_V141.factory, salt, bytecode: deploymentData })
}

/**
 * The fleet's deterministic saltNonce. Binding it to (chainId, owners, threshold) under a fixed tag
 * means: a restart re-derives the SAME Safe address (stable session on the board), two fleets with
 * different signer sets never collide, and no random state has to be persisted anywhere.
 */
export const FLEET_SALT_TAG = 'msgboard-cosign-fleet-v1'
export function deterministicSaltNonce(chainId: number, owners: Hex[], threshold: number): bigint {
  const key = `${FLEET_SALT_TAG}:${chainId}:${owners.map((a) => a.toLowerCase()).join(',')}:${threshold}`
  return BigInt(keccak256(toBytes(key)))
}

const ZERO = '0x0000000000000000000000000000000000000000' as const

/**
 * The benign transaction each session proposes: a 0-value call from the Safe to itself with empty
 * calldata (hits the Safe's fallback handler and returns). Costs the Safe nothing, moves no funds,
 * and is always executable — the safest possible thing to co-sign for an "always proving itself"
 * loop. `nonce` is the Safe's live nonce so the digest stays executable (and advances only when a
 * session is actually executed on-chain).
 */
export function benignSelfCall(safe: Hex, nonce: bigint): SafeTx {
  return {
    to: safe,
    value: 0n,
    data: '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  }
}

// ── relay deploy-request digest + PoW — mirrored from packages/cosign-relay (src/validate.ts, ──
//    src/pow.ts) and packages/cosign-web/src/lib/gasless.ts. MUST match bit-for-bit or the relay
//    rejects the request. ─────────────────────────────────────────────────────────────────────

/**
 * `keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))`. Binding chain +
 * singleton + initializer + saltNonce means a signature over one deploy request can never be
 * replayed against a different chain, singleton, or Safe configuration.
 */
export function deployRequestDigest(args: { chainId: number; singleton: Hex; initializer: Hex; saltNonce: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
      [BigInt(args.chainId), args.singleton, keccak256(args.initializer), args.saltNonce],
    ),
  )
}

/** `keccak256(digest ++ pad(nonce, 32))` — MUST match the relay's `powHash`. */
function powHash(digest: Hex, nonce: Hex): Hex {
  return keccak256(concat([digest, pad(nonce, { size: 32 })]))
}

/** The numeric threshold for `bits` of difficulty — MUST match the relay's `powTarget`. */
function powTarget(bits: number): bigint {
  return 2n ** BigInt(256 - bits)
}

/** Verifies a candidate nonce against `bits` of difficulty. */
export function verifyDeployPow(digest: Hex, nonce: Hex, bits: number): boolean {
  return BigInt(powHash(digest, nonce)) < powTarget(bits)
}

/**
 * Hashcash grind: finds a 32-byte nonce whose `powHash(digest, nonce)` clears `powBits`. Yields to
 * the event loop every `YIELD_EVERY` hashes so a background grind never starves the tick loop. The
 * relay's default difficulty (~20 bits) grinds in ~1s in Node.
 */
const YIELD_EVERY = 4096n
export async function solveDeployPow(digest: Hex, powBits: number): Promise<Hex> {
  const target = powTarget(powBits)
  for (let i = 0n; ; i += 1n) {
    const nonce = toHex(i, { size: 32 })
    if (BigInt(powHash(digest, nonce)) < target) return nonce
    if (i % YIELD_EVERY === 0n) await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ── session-state fold ────────────────────────────────────────────────────────────────────────

/** The distinct owners that have signed a digest, and whether that meets the Safe's threshold. */
export interface SessionFold {
  /** Distinct owner addresses (from `owners`) that produced a valid recovered share. */
  signedOwners: Hex[]
  /** signedOwners.length >= threshold. */
  thresholdMet: boolean
}

/**
 * Folds recovered share signers into the quorum picture for ONE digest. `recovered` is the list of
 * recovered signer addresses (null = a share whose signature didn't recover) for that digest;
 * `owners` + `threshold` come from the live Safe. Mirrors the web app's `signedOwners` derivation:
 * a signer only counts if it is an actual owner, and each owner counts at most once.
 */
export function foldSession(recovered: (Hex | null)[], owners: Hex[], threshold: number): SessionFold {
  const signedOwners: Hex[] = []
  for (const addr of recovered) {
    if (!addr) continue
    if (!owners.some((o) => isAddressEqual(o, addr))) continue
    if (signedOwners.some((s) => isAddressEqual(s, addr))) continue
    signedOwners.push(addr)
  }
  return { signedOwners, thresholdMet: signedOwners.length >= threshold }
}
