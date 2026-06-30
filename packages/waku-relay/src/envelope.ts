import { keccak256, toHex, hexToString, isHex, type Hex } from 'viem'

/**
 * Origin-tagged envelope. The relay can post either the RAW Waku payload or this envelope (default) as
 * the MsgBoard message `data`. Tagging the origin + channel makes the relayed message self-describing
 * and is what a future bidirectional pass uses to skip messages it itself produced (echo suppression).
 */
export type RelayOrigin = 'waku' | 'msgboard'

export const ENVELOPE_VERSION = 1

export interface RelayEnvelope {
  /** envelope version. */
  v: number
  /** the network the message was first seen on. */
  origin: RelayOrigin
  /** the source channel / content-topic name. */
  channel: string
  /** unix ms when the relay first observed it. */
  at: number
  /** the original opaque payload, hex-encoded. */
  body: Hex
}

/**
 * A stable, ORIGIN-INDEPENDENT content id for dedup. The same (channel, body) seen on Waku and later
 * read back from MsgBoard hash to the same id, so echo/duplicate suppression works across both sides.
 */
export function contentId(channel: string, body: Hex): Hex {
  return keccak256(toHex(JSON.stringify({ channel, body: body.toLowerCase() })))
}

/** Wrap a payload as an envelope and hex-encode it for the MsgBoard `data` field. */
export function wrapEnvelope(input: { origin: RelayOrigin; channel: string; body: Hex; at: number }): Hex {
  const env: RelayEnvelope = { v: ENVELOPE_VERSION, origin: input.origin, channel: input.channel, at: input.at, body: input.body }
  return toHex(JSON.stringify(env))
}

/** Parse an envelope back out of MsgBoard `data` hex. Returns null if the data is not a relay envelope. */
export function unwrapEnvelope(data: Hex): RelayEnvelope | null {
  if (!isHex(data)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(hexToString(data))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const e = parsed as Record<string, unknown>
  if (e.v !== ENVELOPE_VERSION) return null
  if (e.origin !== 'waku' && e.origin !== 'msgboard') return null
  if (typeof e.channel !== 'string' || typeof e.at !== 'number' || typeof e.body !== 'string') return null
  return { v: e.v, origin: e.origin, channel: e.channel, at: e.at, body: e.body as Hex }
}
