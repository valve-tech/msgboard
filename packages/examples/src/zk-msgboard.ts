/**
 * zk-msgboard — a Semaphore-style zk-filtered archive over the msgboard board.
 *
 * Port of the concept from https://github.com/nulven/zk-message-board onto MsgBoard.
 * A member of a committed group proves — in zero knowledge — that they are one of the
 * allowed identity commitments, WITHOUT revealing which one, and attaches a nullifier
 * so the archive can rate-limit them. The proof travels inside the board message's
 * `data`; a watcher verifies every proof and passes through ONLY the messages that
 * carry a valid membership proof for the known group with an unused nullifier. That
 * filtered subset — "the messages that made it through the zk msgboard" — IS the
 * zk-filtered archive.
 *
 * Two roles, mirroring the two things the framing asks for:
 *   • post   — produce a Groth16 membership proof + nullifier, bind it to the exact
 *              message, and post to a single category.
 *   • watch  — a `Relayer` sink that REALLY verifies each proof (snarkjs groth16) and
 *              archives only the subset that verifies (valid member, unused nullifier).
 *
 * This module is the reusable core (identity, Merkle tree, proving, verifying, the
 * archive filter). The `main()` at the bottom is the runnable demo; see README.
 *
 * TRUSTED SETUP IS DEV/TEST-ONLY. The committed proving/verifying keys come from a
 * deterministic `snarkjs ... beacon` setup (see scripts/build-zk.ts) whose "toxic
 * waste" is publicly known — anyone could forge proofs. A real deployment needs a
 * genuine multi-party ceremony and the audited Semaphore circuits. See
 * docs/zk-msgboard.md.
 */
import { createRequire } from 'node:module'
import { keccak256, toHex, hexToString, stringToHex, type Hex } from 'viem'

// snarkjs and circomlibjs are `type: module` packages exposing a CommonJS main and no
// TypeScript types. createRequire loads their CJS build directly, sidestepping ESM
// interop quirks; we wrap the untyped surface in typed helpers below.
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snarkjs: any = require('snarkjs')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const circomlibjs: any = require('circomlibjs')

/** The BN254 scalar field snarkjs / circom operate over. */
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/** Merkle depth of the group tree — matches `MembershipProof(10)` in the circuit. */
export const MERKLE_DEPTH = 10

// ----------------------------------------------------------------------------------
// Poseidon (lazily built once; matches the circom `poseidon.circom` gadget exactly).
// ----------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonImpl: any = null
const getPoseidon = async () => {
  if (!poseidonImpl) poseidonImpl = await circomlibjs.buildPoseidon()
  return poseidonImpl
}

/** Poseidon hash of field elements, returned as a bigint in the scalar field. */
export const poseidon = async (inputs: bigint[]): Promise<bigint> => {
  const p = await getPoseidon()
  return BigInt(p.F.toString(p(inputs)))
}

// ----------------------------------------------------------------------------------
// Identities and the group Merkle tree.
// ----------------------------------------------------------------------------------

/** A member's secret identity. Keep the two secrets private; publish only the commitment. */
export type ZkIdentity = { nullifier: bigint; trapdoor: bigint }

/** A group: the ordered identity commitments and the Merkle root over them. */
export type ZkGroup = { depth: number; commitments: string[]; root: string }

const randomField = (): bigint => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return BigInt(toHex(bytes)) % SNARK_FIELD
}

/** Generates a fresh random identity (two field-element secrets). */
export const randomIdentity = (): ZkIdentity => ({ nullifier: randomField(), trapdoor: randomField() })

/**
 * identity commitment = Poseidon(Poseidon(nullifier, trapdoor)), the Semaphore-v2
 * construction the circuit re-derives from the private secrets.
 */
export const identityCommitment = async (identity: ZkIdentity): Promise<bigint> => {
  const secret = await poseidon([identity.nullifier, identity.trapdoor])
  return poseidon([secret])
}

const ZERO_LEAF = 0n

/** A built Merkle tree: all layers bottom-up, plus the root, over a fixed depth. */
export type MerkleTree = { depth: number; layers: bigint[][]; root: bigint }

/** Builds a fixed-depth binary Poseidon Merkle tree, zero-padding empty leaves. */
export const buildMerkleTree = async (leaves: bigint[], depth = MERKLE_DEPTH): Promise<MerkleTree> => {
  const size = 2 ** depth
  if (leaves.length > size) throw new Error(`too many members for depth ${depth} (max ${size})`)
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

/** The authentication path for the leaf at `index`, in the shape the circuit expects. */
export const merkleProof = (tree: MerkleTree, index: number): { pathIndices: number[]; siblings: bigint[] } => {
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

/** Materializes a group descriptor (commitments + root) from a set of identities. */
export const buildGroup = async (identities: ZkIdentity[], depth = MERKLE_DEPTH): Promise<{ group: ZkGroup; tree: MerkleTree }> => {
  const commitments = await Promise.all(identities.map(identityCommitment))
  const tree = await buildMerkleTree(commitments, depth)
  return { group: { depth, commitments: commitments.map(String), root: tree.root.toString() }, tree }
}

// ----------------------------------------------------------------------------------
// Public-signal derivations: the message binding and the epoch scope.
// ----------------------------------------------------------------------------------

/**
 * Reduces the message payload to a field element. Making this a PUBLIC input binds the
 * proof to exactly this message: a valid proof cannot be lifted onto different content.
 */
export const signalHash = (payload: Hex): bigint => BigInt(keccak256(payload)) % SNARK_FIELD

/**
 * The epoch / scope a nullifier is valid within. Deriving it from the category (and an
 * optional epoch label) means "one post per member per epoch" — the rate-limit knob.
 */
export const externalNullifier = (scope: string): bigint => BigInt(keccak256(stringToHex(scope))) % SNARK_FIELD

// ----------------------------------------------------------------------------------
// The board wire envelope.
// ----------------------------------------------------------------------------------

/** snarkjs Groth16 proof shape (opaque to us; verified by snarkjs). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Groth16Proof = Record<string, any>

/**
 * What gets posted as the board message `data`: the membership proof, its public
 * signals, and the actual message payload the member wants to say. publicSignals is
 * `[root, nullifierHash, externalNullifier, signalHash]` (circuit output order).
 */
export type ZkPost = { proof: Groth16Proof; publicSignals: string[]; payload: Hex }

/** Named accessors over the positional publicSignals array. */
export const rootOf = (post: ZkPost): string => post.publicSignals[0]
export const nullifierHashOf = (post: ZkPost): string => post.publicSignals[1]
export const externalNullifierOf = (post: ZkPost): string => post.publicSignals[2]
export const signalHashOf = (post: ZkPost): string => post.publicSignals[3]

/** Encodes a post as the hex `data` of a board message. */
export const encodePost = (post: ZkPost): Hex => toHex(JSON.stringify(post))

/** Decodes a board message's hex `data` back into a post, or null if it isn't one. */
export const decodePost = (data: Hex): ZkPost | null => {
  try {
    const parsed = JSON.parse(hexToString(data)) as ZkPost
    if (!parsed.proof || !Array.isArray(parsed.publicSignals) || parsed.publicSignals.length !== 4) return null
    if (typeof parsed.payload !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

// ----------------------------------------------------------------------------------
// Proving (requires the built wasm + zkey — run `npm run zk:build`).
// ----------------------------------------------------------------------------------

export type ProveArgs = {
  identity: ZkIdentity
  tree: MerkleTree
  index: number
  payload: Hex
  scope: string
  wasmPath: string
  zkeyPath: string
}

/**
 * Produces a real Groth16 membership proof bound to `payload` and `scope`. This is the
 * "post" side: the output is a ready-to-post ZkPost. Needs the built artifacts.
 */
export const proveMembership = async (args: ProveArgs): Promise<ZkPost> => {
  const proof = merkleProof(args.tree, args.index)
  const input = {
    identityNullifier: args.identity.nullifier.toString(),
    identityTrapdoor: args.identity.trapdoor.toString(),
    pathIndices: proof.pathIndices.map(String),
    siblings: proof.siblings.map(String),
    externalNullifier: externalNullifier(args.scope).toString(),
    signalHash: signalHash(args.payload).toString(),
  }
  const { proof: groth16, publicSignals } = await snarkjs.groth16.fullProve(input, args.wasmPath, args.zkeyPath)
  return { proof: groth16, publicSignals, payload: args.payload }
}

/** REAL Groth16 verification against the verification key. No stub. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const verifyProof = async (verificationKey: any, post: ZkPost): Promise<boolean> => {
  try {
    return await snarkjs.groth16.verify(verificationKey, post.publicSignals, post.proof)
  } catch {
    return false
  }
}

// ----------------------------------------------------------------------------------
// The zk-filtered archive: verify + scope + rate-limit, keep only what passes.
// ----------------------------------------------------------------------------------

export type ZkArchiveOptions = {
  /** The Merkle root of the group the archive recognizes. */
  root: string
  /** The verification key JSON from the trusted setup. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verificationKey: any
  /**
   * If set, only posts scoped to this externalNullifier are admitted (an epoch gate).
   * Omit to accept any scope while still rate-limiting per (scope+identity) nullifier.
   */
  externalNullifier?: string
}

/** An admitted, verified message in the archive. Anonymous but provably in-group. */
export type ZkArchiveEntry = { nullifierHash: string; payload: Hex; text: string }

export type OfferResult =
  | { accepted: true; entry: ZkArchiveEntry }
  | { accepted: false; reason: string }

/**
 * Stateful filter behind the watcher. Every candidate is checked against four gates —
 * message binding, group membership (root), proof validity (real snarkjs), and nullifier
 * freshness — and only survivors are archived. Board data is untrusted, so malformed or
 * forged posts are rejected rather than crashing the watcher (cf. multi-sig-collect).
 */
export const makeZkArchive = (options: ZkArchiveOptions) => {
  const seenNullifiers = new Set<string>()
  const entries: ZkArchiveEntry[] = []

  const offer = async (post: ZkPost): Promise<OfferResult> => {
    // 1. message binding — the proof must be for THIS payload (no lifting a proof onto
    //    different content).
    if (signalHashOf(post) !== signalHash(post.payload).toString()) {
      return { accepted: false, reason: 'signal mismatch (proof not bound to this message)' }
    }
    // 2. group membership — the proof's root must be the group we recognize.
    if (rootOf(post) !== options.root) return { accepted: false, reason: 'wrong group (root mismatch)' }
    // 3. epoch scope — optional gate on the externalNullifier.
    if (options.externalNullifier && externalNullifierOf(post) !== options.externalNullifier) {
      return { accepted: false, reason: 'wrong epoch (external nullifier mismatch)' }
    }
    // 4. proof validity — the real cryptographic check.
    if (!(await verifyProof(options.verificationKey, post))) return { accepted: false, reason: 'invalid proof' }
    // 5. rate-limit — one admission per nullifier.
    const nullifier = nullifierHashOf(post)
    if (seenNullifiers.has(nullifier)) return { accepted: false, reason: 'nullifier reused (already posted this epoch)' }

    seenNullifiers.add(nullifier)
    const entry: ZkArchiveEntry = { nullifierHash: nullifier, payload: post.payload, text: safeText(post.payload) }
    entries.push(entry)
    return { accepted: true, entry }
  }

  return {
    offer,
    /** The zk-filtered archive: the subset that made it through, in admission order. */
    list: (): readonly ZkArchiveEntry[] => entries,
    size: (): number => entries.length,
  }
}

/** Best-effort decode of a payload's bytes to text (for logging). */
const safeText = (payload: Hex): string => {
  try {
    return hexToString(payload)
  } catch {
    return payload
  }
}

// ----------------------------------------------------------------------------------
// Runnable demo — offline security walkthrough + live watcher/poster.
// ----------------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http } from 'viem'
import { MsgBoardClient, type Provider, type RPCMessage } from '@msgboard/sdk'
import { Relayer, msgboardContentSource, noopAction, defaultLogger } from '@msgboard/relayer'
import type { RelayerSource } from '@msgboard/relayer'

const HERE = dirname(fileURLToPath(import.meta.url))
const zkPath = (...parts: string[]): string => resolve(HERE, '..', 'zk', ...parts)
const VKEY_PATH = zkPath('verification_key.json')
const WASM_PATH = zkPath('build', 'membership_js', 'membership.wasm')
const ZKEY_PATH = zkPath('build', 'membership_final.zkey')

export const DEFAULT_CATEGORY = 'zkarchive'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))
const artifactsBuilt = (): boolean => existsSync(WASM_PATH) && existsSync(ZKEY_PATH)

/** A relayer source that decodes the category's messages into ZkPosts. */
const zkPostSource = (category: string): RelayerSource<ZkPost> => ({
  poll: async (context) => {
    const messages = (await msgboardContentSource({ category }).poll(context)) as RPCMessage[]
    return messages.map((message) => decodePost(message.data)).filter((post): post is ZkPost => post !== null)
  },
})

/** Flips a hex nibble inside the proof so it is well-formed but no longer valid. */
const tamperProof = (post: ZkPost): ZkPost => {
  const clone = JSON.parse(JSON.stringify(post)) as ZkPost
  const original = clone.proof.pi_a[0] as string
  clone.proof.pi_a[0] = original === '1' ? '2' : '1'
  return clone
}

/** Offline walkthrough of the four filter gates, using the committed fixtures. */
const runOffline = async (): Promise<void> => {
  const vkey = loadJson(VKEY_PATH)
  const group = loadJson(zkPath('fixtures', 'group.json')) as ZkGroup
  const memberPost = loadJson(zkPath('fixtures', 'member-post.json')) as ZkPost
  const member2Post = loadJson(zkPath('fixtures', 'member2-post.json')) as ZkPost
  const outsiderPost = loadJson(zkPath('fixtures', 'outsider-post.json')) as ZkPost

  console.log(`\ngroup root (recognized): ${group.root.slice(0, 24)}…  (${group.commitments.length} members, depth ${group.depth})`)
  console.log('the archive admits only messages carrying a valid membership proof for this group.\n')

  const archive = makeZkArchive({ root: group.root, verificationKey: vkey })

  const report = async (label: string, post: ZkPost): Promise<void> => {
    const result = await archive.offer(post)
    if (result.accepted) console.log(`  ✓ ${label}: ADMITTED — "${result.entry.text}"  (nullifier ${result.entry.nullifierHash.slice(0, 12)}…)`)
    else console.log(`  ✗ ${label}: rejected — ${result.reason}`)
  }

  console.log('two different members of the group post (anonymously):')
  await report('member A', memberPost)
  await report('member B', member2Post)

  console.log('\nan outsider (member of a DIFFERENT group) posts a genuine SNARK proof:')
  const outsiderVerifies = await verifyProof(vkey, outsiderPost)
  console.log(`  their proof is a valid Groth16 proof on its own? ${outsiderVerifies}  — but it is not for OUR group:`)
  await report('outsider', outsiderPost)

  console.log('\nmember A tries to post a second time in the same epoch (double-post):')
  await report('member A replay', memberPost)

  console.log('\na forged message: valid proof lifted onto DIFFERENT content:')
  await report('lifted proof', { ...memberPost, payload: toHex('a message I never proved') })

  console.log('\na tampered proof (one field flipped):')
  await report('tampered proof', tamperProof(memberPost))

  console.log(`\nzk-filtered archive now holds ${archive.size()} message(s) — the subset that made it through:`)
  for (const entry of archive.list()) console.log(`  • "${entry.text}"`)

  if (artifactsBuilt()) {
    console.log('\nbuilt artifacts detected — generating a FRESH proof for a brand-new member (live prove)…')
    const identities = [randomIdentity(), randomIdentity(), randomIdentity()]
    const { group: liveGroup, tree } = await buildGroup(identities)
    const payload = toHex('hello from a freshly-proven member')
    const post = await proveMembership({ identity: identities[1], tree, index: 1, payload, scope: DEFAULT_CATEGORY, wasmPath: WASM_PATH, zkeyPath: ZKEY_PATH })
    const liveArchive = makeZkArchive({ root: liveGroup.root, verificationKey: vkey })
    const result = await liveArchive.offer(post)
    console.log(`  fresh proof verified & admitted? ${result.accepted}`)
  } else {
    console.log('\n(run `npm run zk:build --workspace=packages/examples` to also generate live proofs.)')
  }

  console.log('\nSet MSGBOARD_RPC to run the live watcher, or ZK_MODE=post to post a proven message.\n')
}

/** Live watcher: a sink-only relayer that verifies every proof and archives survivors. */
const runWatch = async (rpcUrl: string, category: string): Promise<void> => {
  const vkey = loadJson(VKEY_PATH)
  const group = process.env.ZK_GROUP_ROOT ?? (loadJson(zkPath('fixtures', 'group.json')) as ZkGroup).root
  const logger = defaultLogger('zk-msgboard')
  const archive = makeZkArchive({ root: group, verificationKey: vkey })

  const relayer = new Relayer<ZkPost>({
    node: { transport: http(rpcUrl) },
    mode: 'observe', // the sink verifies + archives locally; no outbound side effect
    source: zkPostSource(category),
    key: (post) => nullifierHashOf(post),
    // The sink runs for every candidate in both modes — it IS the zk filter/archive.
    sink: {
      record: async (post) => {
        const result = await archive.offer(post)
        if (result.accepted) console.log(`ADMITTED anon member — "${result.entry.text}"  (archive size ${archive.size()})`)
        else console.log(`filtered out — ${result.reason}`)
      },
    },
    condition: () => false, // sink-only: never take an action, just archive
    action: noopAction<ZkPost>(),
    logger,
  })

  relayer.start()
  console.log(`\nwatching the "${category}" category — verifying membership proofs against root ${group.slice(0, 18)}…`)
  console.log(`rpc: ${rpcUrl}\nonly messages with a valid proof + unused nullifier are archived.\n`)

  process.on('SIGINT', async () => {
    console.log('\nstopping…')
    await relayer.stop()
    process.exit(0)
  })
}

/** Post mode: prove membership and submit the proven message to the board. */
const runPost = async (rpcUrl: string, category: string): Promise<void> => {
  if (!artifactsBuilt()) {
    console.log('\nZK_MODE=post needs the built proving artifacts. Run:')
    console.log('  npm run zk:build --workspace=packages/examples\n')
    process.exit(1)
  }
  // In a real deployment the group's commitments are published; here we build a demo
  // group in-process and post as one of its members.
  const identities = [randomIdentity(), randomIdentity(), randomIdentity()]
  const { group, tree } = await buildGroup(identities)
  const text = process.env.ZK_MESSAGE ?? 'anonymous but provably in the group'
  const payload = toHex(text)
  console.log(`\nproving membership in group ${group.root.slice(0, 18)}… and binding to "${text}"…`)
  const post = await proveMembership({ identity: identities[0], tree, index: 0, payload, scope: category, wasmPath: WASM_PATH, zkeyPath: ZKEY_PATH })
  const data = encodePost(post)

  const client = new MsgBoardClient(createPublicClient({ transport: http(rpcUrl) }) as unknown as Provider)
  const status = await client.status()
  client.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
  console.log(`proof ready (${(data.length - 2) / 2} bytes) — grinding proof-of-work (this takes a while)…`)
  const work = await client.doPoW(category, data)
  console.log(`found nonce after ${work.stats.iterations} iterations`)
  const hash = await client.addMessage(work.message)
  console.log(`\nposted proven message — hash ${hash}`)
  console.log(`run the watcher (ZK_GROUP_ROOT=${group.root}) to see it admitted.\n`)
}

async function main(): Promise<void> {
  console.log('\nmsgboard zk-msgboard (zk-filtered archive)')
  console.log('─────────────────────────────────────────')

  const rpcUrl = process.env.MSGBOARD_RPC
  const category = process.env.ZK_CATEGORY ?? DEFAULT_CATEGORY

  if (!rpcUrl) return runOffline()
  if ((process.env.ZK_MODE ?? 'watch') === 'post') return runPost(rpcUrl, category)
  return runWatch(rpcUrl, category)
}

// Run the demo only when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
