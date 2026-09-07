import { type Hex, keccak256 } from 'viem'
import type { Content } from '@msgboard/sdk'
import { type SignatureRecord, decodeRecord, encodeRecord } from './record.js'
import { currentKey, keysForWindow } from './keys.js'
import type { CosignAdapter } from './adapters/adapter.js'

/**
 * The minimal board seam cosign needs. Mirrors the `{ category, data }` shape used by
 * `@gibs/msgboard-games`'s transport so it stays testable with a tiny fake. Wrap the real
 * `@msgboard/sdk` `MsgBoardClient` into this (doPoW + addMessage for posting, content passthrough);
 * see the package README.
 */
export interface BoardClient {
  /** Posts `data` under `category`. Returns whatever the underlying board returns. */
  addMessage(arg: { category: Hex; data: Hex }): Promise<unknown>
  /** Fetches messages for a single category. */
  content(arg: { category: Hex }): Promise<Content>
}

/** Arguments for posting a signature. */
export interface PostSignatureArgs {
  namespace: string
  scope: string
  record: SignatureRecord
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: Date
}

/** Arguments for reading the signature window. */
export interface ReadSignaturesArgs {
  namespace: string
  scope: string
  /** Rolling window length in days (>= 1). */
  days: number
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: Date
}

/**
 * Encodes `record` and posts it under the current UTC-day rotating category.
 * Board / PoW errors surface to the caller.
 */
export async function postSignature(
  board: BoardClient,
  { namespace, scope, record, now }: PostSignatureArgs,
): Promise<unknown> {
  const category = currentKey(namespace, scope, now)
  return board.addMessage({ category, data: encodeRecord(record) })
}

/**
 * Sweeps the rolling window of category keys, decodes each board entry, SKIPS undecodable
 * junk (the board is open — junk under a category is expected), and dedupes by keccak256 of
 * the raw message data. Never silently drops a well-formed record; validity is the adapter's
 * job at aggregate time.
 */
export async function readSignatures(
  board: BoardClient,
  { namespace, scope, days, now }: ReadSignaturesArgs,
): Promise<SignatureRecord[]> {
  const keys = keysForWindow(namespace, scope, days, now)
  const seen = new Set<Hex>()
  const out: SignatureRecord[] = []
  for (const category of keys) {
    const content = await board.content({ category })
    const messages = content[category] ?? []
    for (const message of messages) {
      const data = message.data
      if (!data) continue
      const dedupeKey = keccak256(data)
      if (seen.has(dedupeKey)) continue
      let record: SignatureRecord
      try {
        record = decodeRecord(data)
      } catch {
        continue // undecodable junk under an open category — skip
      }
      seen.add(dedupeKey)
      out.push(record)
    }
  }
  return out
}

/** Groups records by their `digest`, preserving input order within each group. */
export function groupByDigest(records: SignatureRecord[]): Map<Hex, SignatureRecord[]> {
  const groups = new Map<Hex, SignatureRecord[]>()
  for (const record of records) {
    const bucket = groups.get(record.digest)
    if (bucket) bucket.push(record)
    else groups.set(record.digest, [record])
  }
  return groups
}

/**
 * Keeps records the adapter verifies (errors PROPAGATE), then applies the adapter's order,
 * returning submission-ready `{ signer, signature }` pairs.
 */
export async function aggregate(
  records: SignatureRecord[],
  adapter: CosignAdapter,
): Promise<{ signer: Hex; signature: Hex }[]> {
  const kept: SignatureRecord[] = []
  for (const record of records) {
    if (await adapter.verify(record)) kept.push(record)
  }
  return adapter.order(kept).map((r) => ({ signer: r.signer, signature: r.signature }))
}
