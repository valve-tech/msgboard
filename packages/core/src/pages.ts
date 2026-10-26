import type { Content, ContentFilter, RPCMessage } from './types.js'

/**
 * Keyset paging for msgboard_contentPage, txpool_contentPage and
 * txpool_inspectPage.
 *
 * Each paged method answers with `next`: the last key of the page, or null
 * at the end. Pass `next` back unchanged as `after`. This is the Stripe
 * `starting_after`, GraphQL Relay `endCursor` and NEAR `last_key` style.
 * Stop only when `next` is null. A short page, or an empty one, is not the
 * end: the node can cut a page early.
 */

/** msgboard_contentPage takes `limit` from 1 to 1,000. reth v2.7.0.2-pulse, test `content_page_limit_bounds`. */
export const MSGBOARD_PAGE_MAX_LIMIT = 1_000
/** txpool_*Page takes at most 1,000 senders. reth `TXPOOL_PAGE_MAX_SENDERS`. */
export const TXPOOL_PAGE_MAX_LIMIT = 1_000
/** A walk that passes this many pages is broken. A full board is 10,000 messages. */
export const MAX_PAGES = 100_000

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>
export type PageOptions = { limit?: number; maxPages?: number }
type Hex = `0x${string}`

type ErrorLike = { code?: unknown; message?: unknown; cause?: unknown }

type ErrorLikeWithError = ErrorLike & { error?: unknown }

/**
 * The error and up to four `cause` or `.error` links below it. viem wraps
 * the RPC error under `cause`; ethers puts it under `.error`.
 */
const errorChain = (e: unknown): ErrorLike[] => {
  const out: ErrorLike[] = []
  let cur: unknown = e
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i += 1) {
    out.push(cur as ErrorLike)
    const link = cur as ErrorLikeWithError
    cur = link.cause ?? link.error
  }
  return out
}

/** True when the node does not have the method (-32601). */
export const isMethodNotFound = (e: unknown): boolean =>
  errorChain(e).some(
    (x) =>
      x.code === -32601 ||
      (typeof x.message === 'string' && /method not found|does not exist\/is not available/i.test(x.message)),
  )

// Used only in the unfiltered whole-board fallback. "too many arguments" and
// "at most 0" are erigon-pulse's wording; "invalid.*param" is the wording
// node-check's own fallback matched before this module replaced it.
const isArgCountError = (e: unknown): boolean =>
  errorChain(e).some(
    (x) => typeof x.message === 'string' && /too many arguments|at most 0|invalid.*param/i.test(x.message),
  )

const checkLimit = (limit: number, max: number, method: string): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`${method}: limit must be an integer from 1 to ${max}, not ${limit}`)
  }
}

/**
 * Walk one keyset-paged method. The first request has no `after`. Each later
 * request carries the previous page's `next`, unchanged.
 */
export async function* keysetPages<P extends { next: string | null }>(
  call: RpcCall,
  method: string,
  request: Record<string, unknown>,
  opts: { maxPages?: number } = {},
): AsyncGenerator<P> {
  const maxPages = opts.maxPages ?? MAX_PAGES
  let after: string | undefined
  for (let pages = 0; pages < maxPages; pages += 1) {
    const page = (await call(method, [after === undefined ? request : { ...request, after }])) as P | null
    if (!page || typeof page !== 'object' || !('next' in page) || (page.next !== null && typeof page.next !== 'string')) {
      throw new Error(`${method}: the answer has no "next" field, so it is not a keyset page`)
    }
    yield page
    if (page.next === null) return
    if (after !== undefined && page.next.toLowerCase() <= after.toLowerCase()) {
      throw new Error(`${method}: "next" ${page.next} did not move past "after" ${after}`)
    }
    after = page.next
  }
  throw new Error(`${method}: the walk passed ${maxPages} pages and "next" is still not null`)
}

export type ContentPage = { content: Content; next: Hex | null; mode: 'page' | 'whole' }

const pageRequest = (filter: ContentFilter, limit: number): Record<string, unknown> => ({
  limit,
  ...(filter.category !== undefined ? { category: filter.category } : {}),
  // reth reads these as JSON numbers (ContentFilter from_block: Option<u64>).
  ...(filter.fromBlock !== undefined ? { fromBlock: Number(filter.fromBlock) } : {}),
  ...(filter.toBlock !== undefined ? { toBlock: Number(filter.toBlock) } : {}),
})

/**
 * The legacy whole-board read: the exact call content() makes. erigon-pulse
 * refuses any argument, so an empty filter falls back to no params. A
 * filter that erigon cannot apply is an error, never a whole board.
 */
const wholeBoard = async (call: RpcCall, filter: ContentFilter): Promise<Content> => {
  try {
    return ((await call('msgboard_content', [filter])) ?? {}) as Content
  } catch (e) {
    const unfiltered = filter.category === undefined && filter.fromBlock === undefined && filter.toBlock === undefined
    if (!unfiltered || !isArgCountError(e)) throw e
    return ((await call('msgboard_content', [])) ?? {}) as Content
  }
}

/**
 * Read the board in pages with msgboard_contentPage (reth v2.7.0.2-pulse).
 * A node without that method gets one whole-board call, and the one page it
 * gives has `mode: 'whole'`. That is today's read, and erigon-pulse will
 * never have the method, so this fallback stays.
 */
export async function* contentPages(
  call: RpcCall,
  filter: ContentFilter = {},
  opts: PageOptions = {},
): AsyncGenerator<ContentPage> {
  const limit = opts.limit ?? MSGBOARD_PAGE_MAX_LIMIT
  checkLimit(limit, MSGBOARD_PAGE_MAX_LIMIT, 'msgboard_contentPage')
  const pages = keysetPages<{ content: Content; next: Hex | null }>(
    call, 'msgboard_contentPage', pageRequest(filter, limit), opts,
  )
  let first: IteratorResult<{ content: Content; next: Hex | null }>
  try {
    first = await pages.next()
  } catch (e) {
    if (!isMethodNotFound(e)) throw e
    yield { content: await wholeBoard(call, filter), next: null, mode: 'whole' }
    return
  }
  if (first.done) return
  yield { ...first.value, mode: 'page' }
  for await (const page of pages) yield { ...page, mode: 'page' }
}

/**
 * Add a page's messages to `acc`, each hash once. A group keyed by hash
 * (erigon-pulse) becomes a list, with the key as each message's `hash`.
 */
const mergeInto = (acc: Record<string, RPCMessage[]>, page: Record<string, unknown>, seen: Set<string>): void => {
  for (const [category, group] of Object.entries(page)) {
    const list: RPCMessage[] = Array.isArray(group)
      ? (group as RPCMessage[])
      : group && typeof group === 'object'
        ? Object.entries(group as Record<string, object>).map(([hash, m]) => ({ ...m, hash }) as RPCMessage)
        : []
    for (const m of list) {
      const key = String(m.hash).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      ;(acc[category] ??= []).push(m)
    }
  }
}

/**
 * The whole board, read in pages. If a later page meets a node without
 * msgboard_contentPage (a mixed fleet during a reth rollout), start again
 * once with the whole-board read. The iterator itself throws in that case,
 * because it cannot take back the pages it gave.
 */
export const contentAll = async (
  call: RpcCall,
  filter: ContentFilter = {},
  opts: PageOptions = {},
): Promise<Content> => {
  const acc: Record<string, RPCMessage[]> = {}
  const seen = new Set<string>()
  let pages = 0
  try {
    for await (const page of contentPages(call, filter, opts)) {
      mergeInto(acc, page.content as Record<string, unknown>, seen)
      pages += 1
    }
    return acc as Content
  } catch (e) {
    if (pages === 0 || !isMethodNotFound(e)) throw e
    const whole: Record<string, RPCMessage[]> = {}
    mergeInto(whole, (await wholeBoard(call, filter)) as Record<string, unknown>, new Set())
    return whole as Content
  }
}

type SenderMap<T> = Record<string, Record<string, T>>
export type TxpoolContentPage = { pending: SenderMap<unknown>; queued: SenderMap<unknown>; next: Hex | null }
export type TxpoolInspectPage = { pending: SenderMap<string>; queued: SenderMap<string>; next: Hex | null }

const txpoolRequest = (opts: PageOptions): Record<string, unknown> => {
  if (opts.limit === undefined) return {}
  checkLimit(opts.limit, TXPOOL_PAGE_MAX_LIMIT, 'txpool page')
  return { limit: opts.limit }
}

/** Walk txpool_contentPage (reth v2.7.0.1-pulse). `limit` counts senders. */
export const txpoolContentPages = (call: RpcCall, opts: PageOptions = {}): AsyncGenerator<TxpoolContentPage> =>
  keysetPages<TxpoolContentPage>(call, 'txpool_contentPage', txpoolRequest(opts), opts)

/** Walk txpool_inspectPage (reth v2.7.0.1-pulse). `limit` counts senders. */
export const txpoolInspectPages = (call: RpcCall, opts: PageOptions = {}): AsyncGenerator<TxpoolInspectPage> =>
  keysetPages<TxpoolInspectPage>(call, 'txpool_inspectPage', txpoolRequest(opts), opts)
