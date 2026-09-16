import { type Hex, recoverAddress } from 'viem'
import {
  type BoardClient,
  type SignatureRecord,
  SCHEME,
  categoryKey,
  isoDay,
  keysForWindow,
  postSignature,
  readSignatures,
} from '@msgboard/cosign'
import { type Petition, decodePetition, encodePetition } from './descriptor.js'
import { petitionDigest } from './digest.js'
import { PETITION_NS, INDEX_SCOPE, signScope } from './categories.js'

/** Posts `p`'s descriptor to the petition index under the current UTC day's bucket. */
export async function createPetition(
  board: BoardClient,
  p: Petition,
  now: Date = new Date(),
): Promise<unknown> {
  const category = categoryKey(PETITION_NS, INDEX_SCOPE, isoDay(now))
  return board.addMessage({ category, data: encodePetition(p) })
}

/**
 * Signs `p` with `sign` (an EIP-712 digest signer), recovers the signer address from the
 * resulting signature, and posts the resulting SignatureRecord to the board under `p.id`'s
 * signature scope. Returns the posted record.
 */
export async function signPetition(
  board: BoardClient,
  p: Petition,
  verifyingContract: Hex,
  sign: (digest: Hex) => Promise<Hex>,
  now: Date = new Date(),
): Promise<SignatureRecord> {
  const digest = petitionDigest(p, verifyingContract)
  const signature = await sign(digest)
  const signer = await recoverAddress({ hash: digest, signature })
  const record: SignatureRecord = { digest, signer, signature, scheme: SCHEME.EIP712, meta: '0x' }
  await postSignature(board, { namespace: PETITION_NS, scope: signScope(p.id), record, now })
  return record
}

/**
 * Sweeps the rolling `days`-window of the petition index and decodes each posted descriptor,
 * skipping undecodable junk (the board is open) and deduping by petition id.
 */
export async function readPetitions(
  board: BoardClient,
  days: number,
  now: Date = new Date(),
): Promise<Petition[]> {
  const keys = keysForWindow(PETITION_NS, INDEX_SCOPE, days, now)
  const seen = new Set<Hex>()
  const out: Petition[] = []
  for (const category of keys) {
    const content = await board.content({ category })
    const messages = content[category] ?? []
    for (const message of messages) {
      const data = message.data
      if (!data) continue
      let petition: Petition
      try {
        petition = decodePetition(data)
      } catch {
        continue // undecodable junk under an open category — skip
      }
      if (seen.has(petition.id)) continue
      seen.add(petition.id)
      out.push(petition)
    }
  }
  return out
}

/** Delegates to cosign's `readSignatures` over petition `id`'s signature scope. */
export function readPetitionSignatures(
  board: BoardClient,
  id: Hex,
  days: number,
  now?: Date,
): Promise<SignatureRecord[]> {
  return readSignatures(board, { namespace: PETITION_NS, scope: signScope(id), days, now })
}

/** Dedups `records` by lowercased signer address (latest wins), returning a count + signer list. */
export function tally(records: SignatureRecord[]): { count: number; signers: Hex[] } {
  const bySigner = new Map<string, Hex>()
  for (const record of records) {
    bySigner.set(record.signer.toLowerCase(), record.signer.toLowerCase() as Hex)
  }
  const signers = [...bySigner.values()]
  return { count: signers.length, signers }
}

/**
 * Recomputes `p`'s digest under `verifyingContract` and checks that `record.digest` matches it
 * and that the signature recovers to `record.signer` (case-insensitive). Never throws — returns
 * false on any mismatch or recovery failure.
 */
export async function verifySignature(
  p: Petition,
  record: SignatureRecord,
  verifyingContract: Hex,
): Promise<boolean> {
  try {
    const digest = petitionDigest(p, verifyingContract)
    if (record.digest.toLowerCase() !== digest.toLowerCase()) return false
    const recovered = await recoverAddress({ hash: digest, signature: record.signature })
    return recovered.toLowerCase() === record.signer.toLowerCase()
  } catch {
    return false
  }
}
