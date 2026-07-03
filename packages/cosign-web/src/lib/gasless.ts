import { type Hex, concat, encodeAbiParameters, keccak256, pad, toHex } from 'viem'
import { relayConfigUrl, relayDeploySafeUrl } from './config'
import { SAFE_V141 } from './deploy-safe'

/** The relay's `GET /config` shape — which chains it currently sponsors + its PoW difficulty. */
export interface RelayConfig {
  chains: number[]
  powBits: number
}

/**
 * Reads the relay's `/config`. Never throws — a down/misconfigured/absent relay just means the
 * gasless toggle stays hidden (see `CreateSafe`'s `chains.includes(wallet.chainId)` gate), and the
 * user-pays path is completely unaffected.
 */
export async function fetchRelayConfig(): Promise<RelayConfig> {
  try {
    const res = await fetch(relayConfigUrl(), { headers: { accept: 'application/json' } })
    if (!res.ok) return { chains: [], powBits: 0 }
    const json = (await res.json()) as { chains?: unknown; powBits?: unknown }
    const chains = Array.isArray(json.chains) ? json.chains.filter((c): c is number => typeof c === 'number') : []
    const powBits = typeof json.powBits === 'number' ? json.powBits : 0
    return { chains, powBits }
  } catch {
    return { chains: [], powBits: 0 }
  }
}

/**
 * The relay's request digest — MUST match `requestDigest` in `packages/cosign-relay/src/validate.ts`
 * exactly, bit for bit: `keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))`.
 * Binding chain id + singleton + initializer + saltNonce means a signature over one deploy request
 * can never be replayed against a different chain, singleton, or Safe configuration.
 */
export function deployRequestDigest(args: { chainId: number; singleton: Hex; initializer: Hex; saltNonce: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
      [BigInt(args.chainId), args.singleton, keccak256(args.initializer), args.saltNonce],
    ),
  )
}

/** `keccak256(digest ++ pad(nonce, 32))` — MUST match the relay's `powHash` in `src/pow.ts` exactly. */
function powHash(digest: Hex, nonce: Hex): Hex {
  return keccak256(concat([digest, pad(nonce, { size: 32 })]))
}

/** The numeric threshold for `bits` of difficulty — MUST match the relay's `powTarget` exactly. */
function powTarget(bits: number): bigint {
  return 2n ** BigInt(256 - bits)
}

/** Verifies a candidate nonce against `bits` of difficulty (also exercised by the round-trip test). */
export function verifyDeployPow(digest: Hex, nonce: Hex, bits: number): boolean {
  return BigInt(powHash(digest, nonce)) < powTarget(bits)
}

/**
 * Hashcash grind: finds a 32-byte nonce such that `powHash(digest, nonce)` has at least `powBits`
 * leading zero bits. Yields to the event loop every `YIELD_EVERY` hashes (a bare `await` on a
 * microtask is enough to let React re-render / the Cancel button respond) so the grind — ~1s at the
 * relay's default `powBits` of 20 — never freezes the UI thread.
 */
const YIELD_EVERY = 2000n

export async function solveDeployPow(digest: Hex, powBits: number): Promise<Hex> {
  const target = powTarget(powBits)
  for (let i = 0n; ; i += 1n) {
    const nonce = toHex(i, { size: 32 })
    if (BigInt(powHash(digest, nonce)) < target) return nonce
    if (i % YIELD_EVERY === 0n) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

export interface SponsoredDeployArgs {
  chainId: number
  initializer: Hex
  saltNonce: bigint
  signature: Hex
  powNonce: Hex
}

/**
 * POSTs the deploy request to the relay's `/deploy-safe`. `singleton` is always the canonical
 * v1.4.1 L2 singleton (`SAFE_V141.singletonL2`) — the relay rejects anything else — so it's fixed
 * here rather than threaded through from the caller. Returns the relay-submitted tx hash; the
 * caller still runs the SAME `confirmDeploy(...)` against the predicted address as the user-pays
 * path, so a misbehaving relay can never hand back an address that wasn't actually predicted.
 * Throws with the relay's own `{ error }` message on any 4xx/5xx.
 */
export async function sponsoredDeploy(args: SponsoredDeployArgs): Promise<Hex> {
  const res = await fetch(relayDeploySafeUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: args.chainId,
      singleton: SAFE_V141.singletonL2,
      initializer: args.initializer,
      saltNonce: args.saltNonce.toString(),
      signature: args.signature,
      powNonce: args.powNonce,
    }),
  })
  const json = (await res.json().catch(() => ({}))) as { txHash?: Hex; proxy?: Hex; error?: string }
  if (!res.ok) throw new Error(json.error ?? `relay deploy failed (HTTP ${res.status})`)
  if (!json.txHash) throw new Error('relay response missing txHash')
  return json.txHash
}
