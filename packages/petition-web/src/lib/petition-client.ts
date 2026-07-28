import { bytesToHex, parseGwei, type Hex, type TypedDataDefinition } from 'viem'
import type { BoardClient, SignatureRecord } from '@msgboard/cosign'
import {
  type Petition,
  derivePetitionId,
  petitionDigest,
  createPetition as postPetitionDescriptor,
  signPetition as postSignatureRecord,
  verifySignature,
  buildSubmitBatchArgs,
  PETITION_DOMAIN_NAME,
  PETITION_DOMAIN_VERSION,
  PETITION_TYPES,
} from '@msgboard/petition'
import { PETITION_READ_BASE, PETITION_INDEXER_URL } from './config.js'
import { fetchPetitionIndex, fetchAllPetitionSignatures, fetchPetitionTally } from './read-side.js'
import { fetchSettledSigners } from './settled.js'
import { outstanding } from './reconcile.js'

/** A 32-byte random salt, hex-encoded (crypto.getRandomValues — the same source `crypto.randomUUID` uses). */
export const randomSalt = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

/** Polls `check` every `intervalMs` until it resolves `true`, or throws after `timeoutMs`. */
async function pollUntil(
  check: () => Promise<boolean>,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 1500
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error('timed out waiting for the board to capture the post')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export interface PetitionSummary {
  petition: Petition
  /** CAPTURED count — posted-but-unverified, from the read-side tally. See VerifyPanel for the trustless count. */
  capturedCount: number
}

/** `listPetitions` — the Directory's data source: every captured petition descriptor. */
export async function listPetitions(readBase: string = PETITION_READ_BASE): Promise<PetitionSummary[]> {
  const petitions = await fetchPetitionIndex(readBase)
  return Promise.all(
    petitions.map(async (petition) => {
      const t = await fetchPetitionTally(petition.id, readBase).catch(() => ({ count: 0, signers: [] }))
      return { petition, capturedCount: t.count }
    }),
  )
}

export interface PetitionDetail {
  petition: Petition
  /** CAPTURED — posted-but-unverified (read-side tally). Label this as such in the UI. */
  capturedCount: number
  /** VERIFIED — client-recomputed signatures (see `verifyAll`). The trustless number. */
  verifiedSigners: Hex[]
  /** ON-CHAIN (settled) — from the settlement indexer. Hard finality. */
  settledSigners: Hex[]
}

/**
 * Loads a single petition's THREE distinct counts: captured (read-side, fast/unverified),
 * verified (client-recomputed via `verifySignature` — the trustless number), and settled
 * (the on-chain indexer). Returns null if the petition id isn't in the captured index.
 */
export async function getPetition(
  id: Hex,
  verifyingContract: Hex | null,
  chainId: number,
  readBase: string = PETITION_READ_BASE,
  indexerBase: string = PETITION_INDEXER_URL,
): Promise<PetitionDetail | null> {
  const petitions = await fetchPetitionIndex(readBase)
  const petition = petitions.find((p) => p.id.toLowerCase() === id.toLowerCase())
  if (!petition) return null

  const [capturedTally, verified, settledSigners] = await Promise.all([
    fetchPetitionTally(id, readBase),
    verifyingContract ? verifyAll(petition, verifyingContract, readBase) : Promise.resolve({ verifiedSigners: [], records: [], invalidCount: 0 }),
    fetchSettledSigners(chainId, id, indexerBase),
  ])

  return {
    petition,
    capturedCount: capturedTally.count,
    verifiedSigners: verified.verifiedSigners,
    settledSigners,
  }
}

/**
 * `createPetition` — derives the id from a fresh random salt, posts the descriptor to the board
 * via `@msgboard/petition`'s `createPetition` (which routes through the worker board's `addMessage`
 * — PoW off the main thread), then polls the read-side index until it shows up (captured ✓).
 */
export async function createPetition(
  board: BoardClient,
  statement: string,
  creator: Hex,
  chainId: number,
  opts?: { readBase?: string; intervalMs?: number; timeoutMs?: number },
): Promise<Petition> {
  const salt = randomSalt()
  const id = derivePetitionId(statement, creator, salt)
  const petition: Petition = { id, statement, creator, createdAt: Math.floor(Date.now() / 1000), chainId, salt }
  await postPetitionDescriptor(board, petition)
  const readBase = opts?.readBase ?? PETITION_READ_BASE
  await pollUntil(async () => {
    const petitions = await fetchPetitionIndex(readBase)
    return petitions.some((p) => p.id.toLowerCase() === id.toLowerCase())
  }, opts)
  return petition
}

/**
 * `signPetition` — signs `p`'s EIP-712 digest via `signTypedData` (the wallet-provided callback;
 * its signature IS the raw sign over `petitionDigest(p, verifyingContract)`, no extra prefix — the
 * same hash `@msgboard/petition`'s `signPetition` recomputes internally and passes to our `sign`
 * callback, which we ignore in favor of reconstructing the identical typed data so any wallet's
 * standard `eth_signTypedData_v4` flow works), posts the resulting record to the board, then polls
 * the read-side signatures route for `signer` until it appears (captured ✓).
 */
export async function signPetition(
  board: BoardClient,
  petition: Petition,
  verifyingContract: Hex,
  signer: Hex,
  signTypedData: (typedData: TypedDataDefinition) => Promise<Hex>,
  opts?: { readBase?: string; intervalMs?: number; timeoutMs?: number },
): Promise<SignatureRecord> {
  const sign = async (): Promise<Hex> =>
    signTypedData({
      domain: {
        name: PETITION_DOMAIN_NAME,
        version: PETITION_DOMAIN_VERSION,
        chainId: petition.chainId,
        verifyingContract,
      },
      types: PETITION_TYPES,
      primaryType: 'Petition',
      message: { petitionId: petition.id, statement: petition.statement },
    })
  const record = await postSignatureRecord(board, petition, verifyingContract, sign)
  const readBase = opts?.readBase ?? PETITION_READ_BASE
  await pollUntil(async () => {
    const all = await fetchAllPetitionSignatures(petition.id, readBase)
    return all.some((s) => s.signer.toLowerCase() === signer.toLowerCase())
  }, opts)
  return record
}

export interface VerifyResult {
  /** Every captured record, annotated with whether it verified. */
  records: (SignatureRecord & { valid: boolean })[]
  /** Deduped, lowercased signer addresses whose signature verified. THE trustless count. */
  verifiedSigners: Hex[]
  /** Count of captured records that failed verification (forged/tampered/stale). */
  invalidCount: number
}

/**
 * `verifyAll` — fetches every CAPTURED signature for `petition` and recomputes each one
 * client-side via `@msgboard/petition`'s `verifySignature` (recover against the EIP-712 digest for
 * THIS petition's statement + `verifyingContract`). This is the only trustless count in the app —
 * the read-side tally alone just means "someone posted a SignatureRecord naming this signer."
 */
export async function verifyAll(
  petition: Petition,
  verifyingContract: Hex,
  readBase: string = PETITION_READ_BASE,
): Promise<VerifyResult> {
  const raw = await fetchAllPetitionSignatures(petition.id, readBase)
  const results = await Promise.all(
    raw.map(async (r) => ({ ...r, valid: await verifySignature(petition, r, verifyingContract) }),
  ))
  const seen = new Set<string>()
  const verifiedSigners: Hex[] = []
  let invalidCount = 0
  for (const r of results) {
    if (!r.valid) {
      invalidCount++
      continue
    }
    const lower = r.signer.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    verifiedSigners.push(r.signer.toLowerCase() as Hex)
  }
  return { records: results, verifiedSigners, invalidCount }
}

/** EIP-1559 fees for the settle tx: current base fee + a fixed ~2 gwei tip — NEVER a node's raw suggestion. */
const SETTLE_TIP = parseGwei('2')

export interface SettleFees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** Base fee + `SETTLE_TIP`, doubling the base-fee headroom so the tx doesn't stall if it spikes. */
export const settleFeesFor = (baseFeePerGas: bigint): SettleFees => ({
  maxPriorityFeePerGas: SETTLE_TIP,
  maxFeePerGas: baseFeePerGas * 2n + SETTLE_TIP,
})

/**
 * `settle` — builds `submitBatch(petitionId, statement, signers, signatures)` for the OUTSTANDING
 * set (verified-captured minus already-settled — see `reconcile.ts`) and sends it via the wallet's
 * `submitBatch`, with EXPLICIT EIP-1559 fees (base fee + ~2 gwei tip; never the node's auto-estimate
 * — on PulseChain that under-prices and the tx never mines).
 */
export async function settle(
  petition: Petition,
  verifyingContract: Hex,
  verified: VerifyResult,
  settledSigners: Hex[],
  submitBatch: (address: Hex, args: readonly [Hex, string, Hex[], Hex[]], fees: SettleFees) => Promise<Hex>,
  getBaseFeePerGas: () => Promise<bigint>,
): Promise<Hex> {
  const toSettle = outstanding(verified.verifiedSigners, settledSigners)
  if (toSettle.length === 0) throw new Error('nothing outstanding — every verified signer is already settled')

  const bySigner = new Map<string, SignatureRecord>()
  for (const r of verified.records) {
    if (r.valid) bySigner.set(r.signer.toLowerCase(), r)
  }
  const signers: Hex[] = []
  const signatures: Hex[] = []
  for (const s of toSettle) {
    const record = bySigner.get(s.toLowerCase())
    if (!record) continue // shouldn't happen — toSettle is derived from verified.verifiedSigners
    signers.push(record.signer)
    signatures.push(record.signature)
  }

  const args = buildSubmitBatchArgs(petition, signers, signatures)
  const baseFeePerGas = await getBaseFeePerGas()
  return submitBatch(verifyingContract, args, settleFeesFor(baseFeePerGas))
}

/** Re-derives `petitionDigest` — exposed for components that want to display/compare it directly. */
export { petitionDigest }
