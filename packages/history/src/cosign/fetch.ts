import { type Hex, keccak256 } from 'viem'
import { type BoardClient, type CosignAdapter, type SignatureRecord, decodeRecord } from '@msgboard/cosign'
import type { Archive } from '../archive.js'
import type { ResolvedCategory } from './categories.js'

/** A decoded, validated record plus provenance — the route's internal row. */
export type CosignRecordView = SignatureRecord & {
  /** The bytes32 category hash this record was fetched under. */
  category: Hex
  /** Optional human-readable category label (`namespace:scope:isoDay`). */
  category_text?: string
  /** Where the record was fetched from. */
  source: 'board' | 'archive'
}

export type FetchRecordsArgs = {
  categories: ResolvedCategory[]
  board: BoardClient
  /** The long-tail fallback; required only if the window reaches past `boardRetentionDays`. */
  archive?: Archive
  /** Days within this many of `now` are read from the board; older days from the archive. */
  boardRetentionDays: number
  /** Validation adapter; when omitted, every decodable record is kept (kind:"none"). */
  adapter?: CosignAdapter
  /** Injectable clock; defaults to now. */
  now?: Date
  /** Optional label builder for `category_text`. */
  categoryText?: (c: ResolvedCategory) => string
}

const dayMs = 24 * 60 * 60 * 1000

/**
 * Reads the resolved categories, splitting recent days (board) from older days (archive),
 * decodes each entry (skipping junk that `decodeRecord` throws on), validates via
 * `adapter.verify` (dropping `false`; dropping-with-reason on a throw), dedupes by
 * `keccak256(rawData)`, and tags provenance. Source errors PROPAGATE (the route fails the
 * request rather than returning a misleadingly-short window — the §9 statelessness trade).
 */
export const fetchRecords = async (args: FetchRecordsArgs): Promise<CosignRecordView[]> => {
  const { categories, board, archive, boardRetentionDays, adapter, now = new Date(), categoryText } = args
  const today = Math.floor(now.getTime() / dayMs)

  const seen = new Set<Hex>()
  const out: CosignRecordView[] = []

  for (const cat of categories) {
    const dayIndex = today - Math.floor(Date.parse(`${cat.isoDay}T00:00:00.000Z`) / dayMs)
    const fromBoard = dayIndex < boardRetentionDays

    // Each row is the hex `data` blob, whatever the source.
    let datas: Hex[]
    if (fromBoard) {
      const content = await board.content({ category: cat.category })
      datas = (content[cat.category] ?? []).map((m) => m.data).filter((d): d is Hex => Boolean(d))
    } else {
      if (!archive) throw new Error(`fetchRecords: archive required for older day ${cat.isoDay} but none provided`)
      const rows = await archive.query({ category: cat.category, limit: 1000 })
      datas = rows.map((r) => r.data).filter((d): d is Hex => Boolean(d)) as Hex[]
    }

    for (const data of datas) {
      const dedupeKey = keccak256(data)
      if (seen.has(dedupeKey)) continue

      let record: SignatureRecord
      try {
        record = decodeRecord(data)
      } catch {
        continue // undecodable junk under an open category — skip (expected; debug-level)
      }

      if (adapter) {
        let ok: boolean
        try {
          ok = await adapter.verify(record)
        } catch {
          continue // verify-errored (e.g. RPC failure / stubbed adapter) — drop with reason, do not crash
        }
        if (!ok) continue // invalid signature — drop
      }

      seen.add(dedupeKey)
      out.push({
        ...record,
        category: cat.category,
        category_text: categoryText?.(cat),
        source: fromBoard ? 'board' : 'archive',
      })
    }
  }

  return out
}
