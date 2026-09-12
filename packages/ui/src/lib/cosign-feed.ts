import { type Hex, getAddress, isAddressEqual, keccak256 } from 'viem'
import {
  type SignatureRecord,
  SCHEME,
  categoryKey,
  decodeRecord,
  isoDay,
  recoverEffectiveSigner,
} from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'

/**
 * The read side of the landing page's Cosign tab.
 *
 * The board keeps only ~120 blocks of messages, and the cosign fleet posts one session per HOUR,
 * so the live board alone shows almost nothing. This module therefore reads two sources and unions
 * them — the same split the box's own `cosign-archive` service makes server side:
 *
 *   - the ARCHIVE — `message_archive` over Hasura at https://archive.msgboard.xyz/v1/graphql.
 *     It is public, anonymous, read-only, and sends CORS headers, so the browser reaches it
 *     directly. It holds every board message the indexer has ever seen.
 *   - the LIVE BOARD — the app-wide `content` snapshot the chain store already polls every 20s.
 *     It costs zero extra RPC calls and it carries a share the moment it lands, which the archive
 *     only picks up on the indexer's next pass.
 *
 * Everything here takes an options object and stays free of React, so the whole read path is unit
 * testable with a fake `fetch` and a hand-built `content` snapshot.
 *
 * NOTE on the sibling `cosign-archive.msgboard.xyz` service: it exposes a purpose-built
 * `GET /cosign/:namespace/:scope/signatures?days=N` that returns DECODED records. It is live, but
 * its Caddy block emits no `Access-Control-Allow-Origin`, so a browser on msgboard.xyz cannot read
 * the response. Hasura is the reachable source until that changes.
 */

/** The MsgBoard namespace every cosign share is bucketed under. Matches the bot fleet and the web app. */
export const COSIGN_NAMESPACE = 'cosign'

/** The public, anonymous, CORS-enabled GraphQL endpoint over `message_archive`. */
export const ARCHIVE_GRAPHQL_URL: string =
  import.meta.env.VITE_ARCHIVE_GRAPHQL_URL ?? 'https://archive.msgboard.xyz/v1/graphql'

/** A Safe the msgboard bot fleet co-signs on, so the tab always has a live session to show. */
export interface FleetSafe {
  address: Hex
  /** The threshold the fleet configures. The live chain read wins when it succeeds. */
  threshold: number
  /** How many owners the fleet configures — the demo's denominator before the chain read lands. */
  ownerCount: number
}

/**
 * Per-chain fleet Safe. Env override first (explicit `import.meta.env.X` literals so Vite can
 * inline them), else the pinned deployment. `null` means "no fleet Safe on this chain" — the tab
 * says so instead of guessing an address. Mirrors how `Petitions` resolves its verifier.
 *
 * 943 holds the fleet's 2-of-3 Safe, pinned as `SAFE_943` in `ansible/files/games-actors-compose.yml`.
 * 1 and 369 have no fleet Safe, so the tab degrades honestly there.
 */
const SAFE_ENV: Record<number, string | undefined> = {
  369: import.meta.env.VITE_COSIGN_SAFE_369,
  943: import.meta.env.VITE_COSIGN_SAFE_943,
}
const PINNED_SAFES: Record<number, FleetSafe | undefined> = {
  943: {
    address: '0x67D4FBA30DFeFb1AA2d199c33e239dc6BCAfF705',
    threshold: 2,
    ownerCount: 3,
  },
}

/** The fleet Safe for a chain, or null when the fleet does not run one there. */
export function fleetSafeFor({ chainId }: { chainId: number }): FleetSafe | null {
  const override = SAFE_ENV[chainId]
  const pinned = PINNED_SAFES[chainId]
  if (override) return { address: getAddress(override), threshold: pinned?.threshold ?? 2, ownerCount: pinned?.ownerCount ?? 3 }
  return pinned ?? null
}

/**
 * The category scope every share for one Safe shares: `safe:<chainId>:<safe>`, lowercased.
 * Order is law — the bot fleet and cosign-web build the identical string.
 */
export function safeScope({ chainId, safe }: { chainId: number; safe: Hex }): string {
  return `safe:${chainId}:${safe.toLowerCase()}`
}

/** The rolling window of day-bucketed category keys for a Safe, today first then descending. */
export function cosignCategories({
  chainId,
  safe,
  days,
  now = new Date(),
}: {
  chainId: number
  safe: Hex
  days: number
  now?: Date
}): Hex[] {
  if (days < 1) throw new Error('cosignCategories: days >= 1 required')
  const scope = safeScope({ chainId, safe })
  const dayMs = 24 * 60 * 60 * 1000
  const keys: Hex[] = []
  for (let i = 0; i < days; i++) {
    keys.push(categoryKey(COSIGN_NAMESPACE, scope, isoDay(new Date(now.getTime() - i * dayMs))))
  }
  return keys
}

/** Where one share was read from. The board is fresher; the archive reaches further back. */
export type ShareSource = 'board' | 'archive'

/** One co-signature share, decoded, with the board context around it. */
export interface CosignShare {
  record: SignatureRecord
  /** The day-bucket category the share was posted under. */
  category: Hex
  /** The archive's own timestamp, or null for a share read off the live board. */
  seenAt: string | null
  /** The block the message was rooted to, when the source reports one. */
  blockNumber: number | null
  source: ShareSource
}

/**
 * The stable identity of a share — the same record read twice dedupes to one entry. Callers also
 * use it to cache the recovery result, which is the one expensive step in this module.
 */
export const shareId = ({ record }: { record: SignatureRecord }): string =>
  `${record.digest}:${record.signer.toLowerCase()}:${keccak256(record.signature)}`

interface ArchiveRow {
  category: string
  data: string
  block_number: string | number | null
  first_seen_at: string | null
}

/**
 * Queries the archive for every message under `categories` on `chainId`, newest first.
 * Throws on a transport failure or a GraphQL error — the caller decides how to say so.
 */
export async function readArchiveShares({
  endpoint = ARCHIVE_GRAPHQL_URL,
  chainId,
  categories,
  limit = 200,
  fetchImpl = fetch,
  signal,
}: {
  endpoint?: string
  chainId: number
  categories: Hex[]
  limit?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<CosignShare[]> {
  if (!categories.length) return []
  const query = `query CosignShares($chainId: Int!, $categories: [String!], $limit: Int!) {
  message_archive(
    where: { chain_id: { _eq: $chainId }, category: { _in: $categories } }
    order_by: { first_seen_at: desc }
    limit: $limit
  ) { category data block_number first_seen_at }
}`
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { chainId, categories, limit } }),
    signal,
  })
  if (!response.ok) throw new Error(`archive returned HTTP ${response.status}`)
  const json = (await response.json()) as {
    data?: { message_archive?: ArchiveRow[] }
    errors?: { message?: string }[]
  }
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'archive query failed')
  return decodeRows({ rows: json.data?.message_archive ?? [] })
}

/** Decodes archive rows, SKIPPING undecodable ones — the board is open, junk under a category is expected. */
function decodeRows({ rows }: { rows: ArchiveRow[] }): CosignShare[] {
  const out: CosignShare[] = []
  for (const row of rows) {
    if (!row?.data) continue
    let record: SignatureRecord
    try {
      record = decodeRecord(row.data as Hex)
    } catch {
      continue
    }
    out.push({
      record,
      category: row.category as Hex,
      seenAt: row.first_seen_at ?? null,
      blockNumber: row.block_number == null ? null : Number(row.block_number),
      source: 'archive',
    })
  }
  return out
}

/**
 * Pulls shares out of the app-wide `content` snapshot the chain store already polls. Costs no RPC
 * call — it replays the poll's own data — and it carries a share the instant it lands, minutes
 * before the archive indexer records it.
 */
export function readBoardShares({
  content,
  categories,
}: {
  content: Content | null | undefined
  categories: Hex[]
}): CosignShare[] {
  if (!content) return []
  const out: CosignShare[] = []
  for (const category of categories) {
    for (const message of content[category] ?? []) {
      const data = message?.data
      if (!data) continue
      let record: SignatureRecord
      try {
        record = decodeRecord(data as Hex)
      } catch {
        continue
      }
      out.push({ record, category, seenAt: null, blockNumber: null, source: 'board' })
    }
  }
  return out
}

/**
 * Unions the two sources into one feed, newest first. A share present in both keeps its ARCHIVE
 * entry, because only the archive carries a timestamp and a block number.
 */
export function mergeShares({
  archive,
  board,
}: {
  archive: CosignShare[]
  board: CosignShare[]
}): CosignShare[] {
  const byKey = new Map<string, CosignShare>()
  for (const share of archive) byKey.set(shareId({ record: share.record }), share)
  for (const share of board) {
    const key = shareId({ record: share.record })
    if (!byKey.has(key)) byKey.set(key, share)
  }
  return [...byKey.values()].sort((a, b) => {
    // A board share has no timestamp; it is the freshest thing we have, so it sorts first.
    if (a.seenAt === b.seenAt) return 0
    if (!a.seenAt) return -1
    if (!b.seenAt) return 1
    return b.seenAt.localeCompare(a.seenAt)
  })
}

/** A share plus the address its own signature recovers to. */
export interface VerifiedShare extends CosignShare {
  /** The address the signature recovers to, or null when the signature is malformed. */
  recovered: Hex | null
  /** The recovered address matches the address the record claims. Pure crypto — no RPC. */
  selfConsistent: boolean
}

/**
 * Recovers every share's signer from its own digest and signature. This is the trustless half of
 * the tab: anyone can post a record naming any signer, and this check catches that with no chain
 * call at all. Owner membership still needs the Safe's live owner set — see `foldQuorum`.
 */
export async function verifyShares({
  shares,
  cache,
}: {
  shares: CosignShare[]
  /**
   * Optional recovery cache, keyed by `shareId`. Recovering a signature is the only costly step
   * here, and the board poll hands us the same shares every 20 seconds, so a caller that keeps one
   * map across renders pays for each share once.
   */
  cache?: Map<string, Hex | null>
}): Promise<VerifiedShare[]> {
  return Promise.all(
    shares.map(async (share) => {
      const key = shareId({ record: share.record })
      let recovered: Hex | null = null
      if (cache?.has(key)) {
        recovered = cache.get(key) ?? null
      } else {
        try {
          recovered = await recoverEffectiveSigner(share.record)
        } catch {
          recovered = null
        }
        cache?.set(key, recovered)
      }
      const selfConsistent =
        recovered != null &&
        // An EIP-1271 record recovers to its own claimed signer by definition, so the check only
        // means something for the EOA schemes. Say so rather than claiming a proof we did not run.
        (share.record.scheme === SCHEME.EIP1271 || isAddressEqual(recovered, share.record.signer))
      return { ...share, recovered, selfConsistent }
    }),
  )
}

/** Groups verified shares by the digest they sign, newest digest first. */
export function groupByDigest({ shares }: { shares: VerifiedShare[] }): Map<Hex, VerifiedShare[]> {
  const groups = new Map<Hex, VerifiedShare[]>()
  for (const share of shares) {
    const bucket = groups.get(share.record.digest)
    if (bucket) bucket.push(share)
    else groups.set(share.record.digest, [share])
  }
  return groups
}

/** The quorum picture for ONE digest. */
export interface QuorumFold {
  /** Distinct Safe owners that produced a self-consistent signature. Each owner counts once. */
  signedOwners: Hex[]
  /** Signers whose signature checks out but who are not owners — they never count. */
  outsiders: Hex[]
  /** `signedOwners.length >= threshold`. */
  thresholdMet: boolean
}

/**
 * Folds one digest's shares into the quorum picture. A signer counts only when its signature
 * recovers to the address it claims AND that address is a live Safe owner; each owner counts at
 * most once. Mirrors the bot fleet's own `foldSession`, so the tab and the fleet agree.
 */
export function foldQuorum({
  shares,
  owners,
  threshold,
}: {
  shares: VerifiedShare[]
  owners: Hex[]
  threshold: number
}): QuorumFold {
  const signedOwners: Hex[] = []
  const outsiders: Hex[] = []
  for (const share of shares) {
    const addr = share.recovered
    if (!addr || !share.selfConsistent) continue
    if (!owners.some((o) => isAddressEqual(o, addr))) {
      if (!outsiders.some((s) => isAddressEqual(s, addr))) outsiders.push(addr)
      continue
    }
    if (signedOwners.some((s) => isAddressEqual(s, addr))) continue
    signedOwners.push(addr)
  }
  return { signedOwners, outsiders, thresholdMet: signedOwners.length >= threshold }
}
