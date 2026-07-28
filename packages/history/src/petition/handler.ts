import type { Hex } from 'viem'
import type { BoardClient } from '@msgboard/cosign'
import { tally } from '@msgboard/petition'
import type { Archive } from '../archive.js'
import { type CosignRecordView, fetchRecords } from '../cosign/fetch.js'
import { resolveIndexCategories, resolveSignatureCategories } from './categories.js'
import { fetchPetitions, type PetitionView } from './fetch.js'
import type { PetitionRoute } from './router.js'

/** Everything the petition handler needs, injected by the server (and by tests). */
export type PetitionDeps = {
  board: BoardClient
  archive?: Archive
  /** Conservative board-retention cutoff (days) for the board-vs-archive split (§8/§14). */
  boardRetentionDays: number
  /** Default + clamp for the rolling `days` window; petitions have no team-file, so this
   *  is the group-wide equivalent of cosign's per-scope `windowDays`. Defaults to 7. */
  windowDays?: number
  /** Injectable clock; defaults to `() => new Date()`. */
  now?: () => Date
}

/** A handler result the server maps onto `respond(res, status, body)`. */
export type PetitionResult = { status: number; body: unknown }

const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_SIGNATURES_LIMIT = 200
const MAX_LIMIT = 1000

const num = (params: URLSearchParams, key: string): number | undefined => {
  const raw = params.get(key)
  if (raw === null || !Number.isFinite(Number(raw))) return undefined
  return Number(raw)
}

const clampDays = (days: number | undefined, windowDays: number): number => {
  if (days === undefined || !Number.isFinite(days)) return windowDays
  const floored = Math.floor(days)
  if (floored < 1) return 1
  return Math.min(floored, windowDays)
}

const paginate = <T>(items: T[], params: URLSearchParams, defaultLimit: number): T[] => {
  const offset = Math.max(Math.floor(num(params, 'offset') ?? 0), 0)
  const limitRaw = num(params, 'limit')
  const limit =
    limitRaw !== undefined && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
      : defaultLimit
  return items.slice(offset, offset + limit)
}

/** Maps a decoded petition descriptor to its JSON view (drops fetch provenance). */
const toDescriptor = (p: PetitionView) => ({
  id: p.id,
  statement: p.statement,
  creator: p.creator,
  createdAt: p.createdAt,
  chainId: p.chainId,
  salt: p.salt,
})

/** Maps a raw signature record to its JSON view (mirrors the cosign route's toView). */
const toSignatureView = (r: CosignRecordView) => ({
  digest: r.digest,
  signer: r.signer,
  signature: r.signature,
  scheme: r.scheme,
  meta: r.meta,
  category: r.category,
  category_text: r.category_text,
  source: r.source,
})

/**
 * The petition endpoint group, transport-agnostic — mirrors `handleCosignRequest` minus
 * the team-file/owners concept (petitions have no owner set, so every id is servable):
 * clamps `days`, fetches+decodes over the board (+archive fallback), then shapes JSON.
 * Board/archive errors → 502; anything else → 500.
 */
export const handlePetitionRequest = async (
  route: PetitionRoute,
  params: URLSearchParams,
  deps: PetitionDeps,
): Promise<PetitionResult> => {
  const now = (deps.now ?? (() => new Date()))()
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS
  const days = clampDays(num(params, 'days'), windowDays)

  if (route.kind === 'index') {
    const categories = resolveIndexCategories(days, now)
    try {
      const petitions = await fetchPetitions({
        categories,
        board: deps.board,
        archive: deps.archive,
        boardRetentionDays: deps.boardRetentionDays,
        now,
        categoryText: (c) => `petition:index:${c.isoDay}`,
      })
      return { status: 200, body: { petitions: petitions.map(toDescriptor) } }
    } catch (error) {
      // Board/archive unavailable at query time — fail loudly, do not return a short window.
      return {
        status: 502,
        body: { ok: false, error: error instanceof Error ? error.message : 'fetch failed' },
      }
    }
  }

  const id = route.id as Hex
  const categories = resolveSignatureCategories(id, days, now)

  let records: CosignRecordView[]
  try {
    records = await fetchRecords({
      categories,
      board: deps.board,
      archive: deps.archive,
      boardRetentionDays: deps.boardRetentionDays,
      now,
      categoryText: (c) => `petition:${id}:${c.isoDay}`,
    })
  } catch (error) {
    return {
      status: 502,
      body: { ok: false, error: error instanceof Error ? error.message : 'fetch failed' },
    }
  }

  try {
    if (route.kind === 'signatures') {
      const page = paginate(records, params, DEFAULT_SIGNATURES_LIMIT)
      return {
        status: 200,
        body: { id, signatures: page.map(toSignatureView), total: records.length },
      }
    }

    // route.kind === 'tally' — the headline endpoint
    const { count, signers } = tally(records)
    const signersOut = paginate(signers, params, signers.length || 1)
    return { status: 200, body: { id, count, signers: signersOut } }
  } catch (error) {
    return {
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : 'petition query failed' },
    }
  }
}
