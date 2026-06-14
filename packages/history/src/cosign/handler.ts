import type { Hex } from 'viem'
import { type BoardClient, type CosignAdapter, aggregate, groupByDigest } from '@msgboard/cosign'
import type { Archive } from '../archive.js'
import { resolveCategories } from './categories.js'
import { type CosignRecordView, fetchRecords } from './fetch.js'
import type { CosignRoute } from './router.js'
import type { TeamFile } from './team-file.js'

/** Everything the cosign handler needs, injected by the server (and by tests). */
export type CosignDeps = {
  teamFile: TeamFile
  board: BoardClient
  archive?: Archive
  adapter?: CosignAdapter
  /** Conservative board-retention cutoff (days) for the board-vs-archive split (§8/§14). */
  boardRetentionDays: number
  /** Injectable clock; defaults to `() => new Date()`. */
  now?: () => Date
}

/** A handler result the server maps onto `respond(res, status, body)`. */
export type CosignResult = { status: number; body: unknown }

/** Maps a raw record to its JSON view (§6 SignatureRecordView). */
const toView = (r: CosignRecordView) => ({
  digest: r.digest,
  signer: r.signer,
  signature: r.signature,
  scheme: r.scheme,
  meta: r.meta,
  category: r.category,
  category_text: r.category_text,
  source: r.source,
})

const num = (params: URLSearchParams, key: string): number | undefined => {
  const raw = params.get(key)
  if (raw === null || !Number.isFinite(Number(raw))) return undefined
  return Number(raw)
}

/**
 * The cosign endpoint group, transport-agnostic: validates the scope against the team-file,
 * clamps `days`, fetches+decodes+validates over the board (+archive fallback), then
 * `groupByDigest`/`aggregate`s and shapes the §6 JSON. Board/archive errors → 502; the
 * unknown scope → 404; owners-unimplemented → 501; anything else → 500.
 */
export const handleCosignRequest = async (
  route: CosignRoute,
  params: URLSearchParams,
  deps: CosignDeps,
): Promise<CosignResult> => {
  const now = (deps.now ?? (() => new Date()))()

  const team = deps.teamFile.resolve(route.namespace, route.scope)
  if (!team) return { status: 404, body: { ok: false, error: 'unknown scope' } }

  // owners passthrough — independent of fetch
  if (route.kind === 'owners') {
    const adapter = deps.adapter
    if (!adapter?.owners || !adapter?.threshold)
      return { status: 501, body: { ok: false, error: 'owners not supported by adapter' } }
    try {
      const [owners, threshold] = await Promise.all([adapter.owners(), adapter.threshold()])
      return { status: 200, body: { owners, threshold } }
    } catch (error) {
      return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : 'owners failed' } }
    }
  }

  const days = deps.teamFile.clampDays(num(params, 'days'))
  const categories = resolveCategories(route.namespace, route.scope, days, now)

  let records: CosignRecordView[]
  try {
    records = await fetchRecords({
      categories,
      board: deps.board,
      archive: deps.archive,
      boardRetentionDays: deps.boardRetentionDays,
      adapter: deps.adapter,
      now,
      categoryText: (c) => `${route.namespace}:${route.scope}:${c.isoDay}`,
    })
  } catch (error) {
    // Board/archive unavailable at query time — fail loudly (§9), do not return a short window.
    return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : 'fetch failed' } }
  }

  try {
    if (route.kind === 'signatures') {
      return { status: 200, body: { signatures: records.map(toView) } }
    }

    const digest = route.digest as Hex
    const group = groupByDigest(records).get(digest) ?? []

    if (route.kind === 'digest') {
      const signers = group.map((r) => r.signer)
      return {
        status: 200,
        body: { digest, signatures: group.map(toView), signers, count: signers.length },
      }
    }

    // route.kind === 'aggregate' — the headline endpoint
    const ordered = deps.adapter
      ? await aggregate(group, deps.adapter)
      : group.map((r) => ({ signer: r.signer, signature: r.signature }))
    const withScheme = ordered.map((o) => {
      const match = group.find((g) => g.signer === o.signer)
      return { signer: o.signer, signature: o.signature, scheme: match?.scheme ?? 0 }
    })
    const threshold = num(params, 'threshold')
    return {
      status: 200,
      body: {
        digest,
        signers: withScheme,
        count: withScheme.length,
        threshold,
        ready: threshold === undefined ? undefined : withScheme.length >= threshold,
      },
    }
  } catch (error) {
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : 'cosign query failed' } }
  }
}
