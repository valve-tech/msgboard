import { type Hex, keccak256 } from 'viem'
import type { BoardClient } from '@msgboard/cosign'
import { type Petition, decodePetition } from '@msgboard/petition'
import type { Archive } from '../archive.js'
import type { ResolvedCategory } from './categories.js'

/** A decoded petition descriptor plus provenance — the index route's internal row. */
export type PetitionView = Petition & {
  /** The bytes32 category hash this descriptor was fetched under. */
  category: Hex
  /** Optional human-readable category label (`petition:index:isoDay`). */
  category_text?: string
  /** Where the descriptor was fetched from. */
  source: 'board' | 'archive'
}

export type FetchPetitionsArgs = {
  categories: ResolvedCategory[]
  board: BoardClient
  /** The long-tail fallback; required only if the window reaches past `boardRetentionDays`. */
  archive?: Archive
  /** Days within this many of `now` are read from the board; older days from the archive. */
  boardRetentionDays: number
  /** Injectable clock; defaults to now. */
  now?: Date
  /** Optional label builder for `category_text`. */
  categoryText?: (c: ResolvedCategory) => string
}

const dayMs = 24 * 60 * 60 * 1000

/**
 * Reads the resolved index categories, splitting recent days (board) from older days
 * (archive) — mirroring `cosign/fetch.ts`'s split — decodes each entry via
 * `decodePetition` (skipping junk it throws on), dedupes first by raw-data hash and
 * then by petition id (a petition may be reposted verbatim on a later day), and tags
 * provenance. Source errors PROPAGATE (the route fails the request rather than
 * returning a misleadingly-short window, matching the cosign fetch's §9 trade).
 */
export const fetchPetitions = async (args: FetchPetitionsArgs): Promise<PetitionView[]> => {
  const { categories, board, archive, boardRetentionDays, now = new Date(), categoryText } = args
  const today = Math.floor(now.getTime() / dayMs)

  const seenData = new Set<Hex>()
  const seenId = new Set<Hex>()
  const out: PetitionView[] = []

  for (const cat of categories) {
    const dayIndex = today - Math.floor(Date.parse(`${cat.isoDay}T00:00:00.000Z`) / dayMs)
    const fromBoard = dayIndex < boardRetentionDays

    // Each row is the hex `data` blob, whatever the source.
    let datas: Hex[]
    if (fromBoard) {
      const content = await board.content({ category: cat.category })
      datas = (content[cat.category] ?? []).map((m) => m.data).filter((d): d is Hex => Boolean(d))
    } else {
      if (!archive)
        throw new Error(
          `fetchPetitions: archive required for older day ${cat.isoDay} but none provided`,
        )
      const rows = await archive.query({ category: cat.category, limit: 1000 })
      datas = rows.map((r) => r.data).filter((d): d is Hex => Boolean(d)) as Hex[]
    }

    for (const data of datas) {
      const dedupeKey = keccak256(data)
      if (seenData.has(dedupeKey)) continue
      seenData.add(dedupeKey)

      let petition: Petition
      try {
        petition = decodePetition(data)
      } catch {
        continue // undecodable junk under an open category — skip (expected; debug-level)
      }

      if (seenId.has(petition.id)) continue
      seenId.add(petition.id)

      out.push({
        ...petition,
        category: cat.category,
        category_text: categoryText?.(cat),
        source: fromBoard ? 'board' : 'archive',
      })
    }
  }

  return out
}
