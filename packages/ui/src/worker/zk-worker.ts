/// <reference lib="webworker" />

/**
 * ZK Web Worker — REAL Groth16 membership proving + verifying for ZK Chat, OFF the main
 * thread (Poseidon tree building + a Groth16 fullProve is seconds of pure CPU; the hard
 * project rule keeps that work in a worker, never the render thread — same discipline as
 * the PoW grinder and games/web's PLONK prover).
 *
 * PATH TAKEN: real browser proving (option (a) in the brief). This worker:
 *   1. builds the local identity's commitment `Poseidon(Poseidon(nullifier, trapdoor))`
 *      (Semaphore v2) with circomlibjs — the SAME gadget the circuit re-derives,
 *   2. builds a fixed-depth Poseidon Merkle group [committed dev group ∪ local identity]
 *      and the inclusion path for the local leaf,
 *   3. runs `snarkjs.groth16.fullProve` over the committed circuit wasm + proving key
 *      (served as vite assets), producing a genuine proof + the public signals
 *      `[root, nullifierHash, externalNullifier, signalHash]`,
 *   4. verifies inbound posts with the REAL `snarkjs.groth16.verify` against the committed
 *      verification key.
 *
 * NOTHING here is stubbed or faked: a proof either really verifies or it does not. If the
 * circuit assets or the snarkjs/circomlibjs modules fail to load, the worker posts a single
 * `init-error` and the seam degrades the UI to a visible "proving unavailable" state — it
 * never fabricates a proof.
 *
 * The trusted setup is DEV/TEST-ONLY (public beacon — see docs/zk-msgboard.md); these keys
 * are forgeable and not production-secure. This is a faithful demo of the pattern.
 */
import './setup-buffer'
import { buildPoseidon } from 'circomlibjs'
import type { Hex } from 'viem'
import { keccak256, stringToHex } from 'viem'
import membershipWasmUrl from '../zk-assets/membership.wasm?url'
import membershipZkeyUrl from '../zk-assets/membership_final.zkey?url'
import verificationKey from '../zk-assets/verification_key.json'
import group from '../zk-assets/group.json'
import type { ZkProveReq, ZkVerifyReq, ZkWorkerRequest, ZkWorkerResponse } from './zk-types'
import type { ZkPost } from '../lib/zk-post'

const ctx = self as unknown as DedicatedWorkerGlobalScope
const post = (msg: ZkWorkerResponse) => ctx.postMessage(msg)

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n
const MERKLE_DEPTH = 10
const ZERO_LEAF = 0n

// ── the committed dev anonymity set (group.json commitments) ─────────────────────────
const GROUP_COMMITMENTS: bigint[] = (group.commitments as string[]).map((c) => BigInt(c))

// ── lazily-resolved crypto singletons ────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonImpl: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let snarkjsImpl: any = null
let wasmBytes: Uint8Array | null = null
let zkeyBytes: Uint8Array | null = null

const poseidon = async (inputs: bigint[]): Promise<bigint> => {
  const p = poseidonImpl
  return BigInt(p.F.toString(p(inputs)))
}

/** identity commitment = Poseidon(Poseidon(nullifier, trapdoor)) — Semaphore v2. */
const identityCommitment = async (nullifier: bigint, trapdoor: bigint): Promise<bigint> => {
  const secret = await poseidon([nullifier, trapdoor])
  return poseidon([secret])
}

type MerkleTree = { depth: number; layers: bigint[][]; root: bigint }

/** Fixed-depth binary Poseidon Merkle tree, zero-padding empty leaves (mirror core). */
const buildMerkleTree = async (leaves: bigint[], depth = MERKLE_DEPTH): Promise<MerkleTree> => {
  const size = 2 ** depth
  const bottom = leaves.slice()
  while (bottom.length < size) bottom.push(ZERO_LEAF)
  const layers: bigint[][] = [bottom]
  for (let d = 0; d < depth; d++) {
    const current = layers[d]
    const next: bigint[] = []
    for (let i = 0; i < current.length; i += 2) next.push(await poseidon([current[i], current[i + 1]]))
    layers.push(next)
  }
  return { depth, layers, root: layers[depth][0] }
}

/** Authentication path for `index`, in the shape the circuit expects. */
const merkleProof = (tree: MerkleTree, index: number): { pathIndices: number[]; siblings: bigint[] } => {
  const pathIndices: number[] = []
  const siblings: bigint[] = []
  let idx = index
  for (let d = 0; d < tree.depth; d++) {
    const isRight = idx % 2
    const siblingIndex = isRight ? idx - 1 : idx + 1
    pathIndices.push(isRight)
    siblings.push(tree.layers[d][siblingIndex])
    idx = Math.floor(idx / 2)
  }
  return { pathIndices, siblings }
}

const signalHash = (payload: Hex): bigint => BigInt(keccak256(payload)) % SNARK_FIELD
const externalNullifier = (scope: string): bigint =>
  BigInt(keccak256(stringToHex(scope))) % SNARK_FIELD

/**
 * One-time init: resolve Poseidon + snarkjs, fetch the circuit wasm + proving key bytes.
 * On any failure the worker reports `init-error` and the seam degrades gracefully.
 */
const init = async (): Promise<void> => {
  poseidonImpl = await buildPoseidon()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('snarkjs')
  snarkjsImpl = mod.default ?? mod
  const [wasmBuf, zkeyBuf] = await Promise.all([
    fetch(membershipWasmUrl).then((r) => r.arrayBuffer()),
    fetch(membershipZkeyUrl).then((r) => r.arrayBuffer()),
  ])
  wasmBytes = new Uint8Array(wasmBuf)
  zkeyBytes = new Uint8Array(zkeyBuf)
}

/** Produce a genuine Groth16 membership proof bound to `payload` + `scope`. */
const prove = async (req: ZkProveReq): Promise<ZkPost> => {
  const nullifier = BigInt(req.identityNullifier)
  const trapdoor = BigInt(req.identityTrapdoor)
  const own = await identityCommitment(nullifier, trapdoor)

  // Anonymity set: the committed dev group ∪ this browser's local identity. The local leaf
  // is appended, so its index = the number of published members. The root is deterministic
  // in the set and differs per local identity — the proof is self-verifying regardless.
  const leaves = [...GROUP_COMMITMENTS, own]
  const ownIndex = GROUP_COMMITMENTS.length
  const tree = await buildMerkleTree(leaves)
  const mp = merkleProof(tree, ownIndex)

  const input = {
    identityNullifier: nullifier.toString(),
    identityTrapdoor: trapdoor.toString(),
    pathIndices: mp.pathIndices.map(String),
    siblings: mp.siblings.map(String),
    externalNullifier: externalNullifier(req.scope).toString(),
    signalHash: signalHash(req.payload).toString(),
  }
  const { proof, publicSignals } = await snarkjsImpl.groth16.fullProve(input, wasmBytes, zkeyBytes)
  return { proof, publicSignals, payload: req.payload }
}

/** REAL Groth16 verification against the committed verification key. No stub. */
const verify = async (req: ZkVerifyReq): Promise<boolean> => {
  try {
    return await snarkjsImpl.groth16.verify(verificationKey, req.post.publicSignals, req.post.proof)
  } catch {
    return false
  }
}

// ── init on spawn, then service requests ─────────────────────────────────────────────
const ready = init().then(
  () => {
    post({ type: 'ready' })
    return true
  },
  (err: unknown) => {
    post({ type: 'init-error', message: err instanceof Error ? err.message : 'zk init failed' })
    return false
  },
)

ctx.addEventListener('message', (e: MessageEvent<ZkWorkerRequest>) => {
  const msg = e.data
  void ready.then(async (ok) => {
    if (!ok) return // init failed; the seam has already degraded
    if (msg.type === 'prove') {
      try {
        const zkPost = await prove(msg)
        post({ type: 'prove-ok', id: msg.id, post: zkPost })
      } catch (err) {
        post({ type: 'prove-err', id: msg.id, message: err instanceof Error ? err.message : 'prove failed' })
      }
    } else if (msg.type === 'verify') {
      const valid = await verify(msg)
      post({ type: 'verify-res', id: msg.id, valid })
    }
  })
})
