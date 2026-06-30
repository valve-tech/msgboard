import { bytesToHex, type Hex } from 'viem'
import { categoryFor, DEFAULT_CATEGORY_ENCODING, type CategoryEncoding } from './category.js'
import { contentId, wrapEnvelope } from './envelope.js'
import type { SeenStore } from './seen.js'
import type { WakuMessage, WakuSource } from './waku.js'

export type BodyMode = 'envelope' | 'raw'

export interface RelayStats {
  received: number
  relayed: number
  skippedDuplicate: number
  failed: number
}

export interface RelayDeps {
  /** the Waku read side. */
  source: WakuSource
  /** posts a stamped message to the board; returns the message hash. */
  post: (category: Hex, data: Hex) => Promise<Hex>
  /** dedup store (idempotency across redelivery + restart). */
  seen: SeenStore
  /** channels (topic names) to subscribe + relay. */
  channels: string[]
  /** how channel names become board categories — default 'keccak256', flip to 'ascii32'. */
  categoryEncoding?: CategoryEncoding
  /** post the origin-tagged envelope (default) or the raw Waku payload. */
  bodyMode?: BodyMode
  log?: (msg: string, meta?: unknown) => void
  /** called when a single message fails to relay (after it is left un-remembered for retry). */
  onError?: (error: unknown, message: WakuMessage) => void
  /** injectable clock (tests). */
  now?: () => number
}

export interface Relay {
  start(): Promise<void>
  stop(): Promise<void>
  stats(): RelayStats
}

/**
 * The one-way Waku -> MsgBoard bridge. For each delivered Waku message it: dedups by content id, maps the
 * channel to a board category, builds the data (envelope or raw), and posts a stamped message. Posts are
 * SERIALIZED through a single-flight queue: the PoW stamp is CPU-bound and the SDK grinder polls the
 * chain head, so running stamps concurrently would thrash — one at a time keeps each grind on a fresh
 * block. A message is marked seen only AFTER a successful post, so a failed post can retry on redelivery;
 * an in-flight set prevents a concurrent redelivery from double-posting in the meantime.
 */
export function createRelay(deps: RelayDeps): Relay {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const categoryEncoding = deps.categoryEncoding ?? DEFAULT_CATEGORY_ENCODING
  const bodyMode = deps.bodyMode ?? 'envelope'
  const stats: RelayStats = { received: 0, relayed: 0, skippedDuplicate: 0, failed: 0 }

  const inFlight = new Set<string>()
  let queue: Promise<void> = Promise.resolve()

  const handle = (message: WakuMessage): void => {
    stats.received++
    const body = bytesToHex(message.payload)
    const id = contentId(message.channel, body)
    if (deps.seen.has(id) || inFlight.has(id)) {
      stats.skippedDuplicate++
      return
    }
    inFlight.add(id)
    // chain onto the serial queue so only one stamp/post runs at a time.
    queue = queue.then(async () => {
      try {
        const category = categoryFor(message.channel, categoryEncoding)
        const data = bodyMode === 'envelope'
          ? wrapEnvelope({ origin: 'waku', channel: message.channel, body, at: now() })
          : body
        const hash = await deps.post(category, data)
        deps.seen.remember(id)
        stats.relayed++
        log('relayed', { channel: message.channel, category, hash, id })
      } catch (error) {
        stats.failed++
        log('relay failed', { channel: message.channel, id, error: String(error) })
        deps.onError?.(error, message)
      } finally {
        inFlight.delete(id)
      }
    })
  }

  return {
    start: async () => {
      await deps.source.start()
      await deps.source.subscribe(deps.channels, handle)
      log('relay started', { channels: deps.channels, categoryEncoding, bodyMode })
    },
    stop: async () => {
      await deps.source.stop()
      await queue // let any in-flight post finish
      log('relay stopped', stats)
    },
    stats: () => ({ ...stats }),
  }
}
