import { keccak256, encodeAbiParameters, parseAbiParameters, concat, stringToHex, recoverMessageAddress, type Hex } from 'viem'

export interface Envelope {
  tableId: Hex
  seq: number
  prev: Hex          // head hash before this entry (chain link)
  kind: string       // 'KEYGEN' | 'SHUFFLE' | 'DEAL_SHARE' | game moves...
  body: unknown      // JSON-serializable; hex blobs inside
  from: Hex          // signer address
  sig: Hex           // EIP-191 over the entry digest
  timing?: TurnTiming // OPTIONAL, NON-SIGNED client-side wall-clock metadata (see entryDigest)
}

/**
 * Per-turn wall-clock timing, captured client-side as transcript-entry metadata.
 *
 * CRITICAL: timing is metadata ONLY. It lives on the Envelope wrapper, never
 * inside `body` and never inside the signed SessionState. `entryDigest` reads a
 * fixed tuple (tableId, seq, prev, kind, body) and does NOT read this field, so
 * timing cannot change the entry digest, the envelope signature, the transcript
 * head, the co-signed SessionState digest, or `gameStateHash`. A transcript with
 * timing replays/verifies byte-for-byte identically to one without it.
 *
 * All fields are epoch milliseconds (Date.now()). Each is independently optional:
 * a turn may be recorded with partial timing (e.g. offered+signed but not yet
 * confirmed), and a legacy transcript carries none at all.
 */
export interface TurnTiming {
  /** when the actor received the state it had to act on */
  offeredAt?: number
  /** when this party signed its next state */
  signedAt?: number
  /** when the entry was submitted to the transport */
  broadcastAt?: number
  /** when the counter-signature / landing was observed */
  confirmedAt?: number
}

/** Injectable wall clock; the running driver uses Date.now(), tests pass a fake. */
export type Clock = () => number

export const systemClock: Clock = () => Date.now()

/** Subtract two timing marks, returning undefined unless both exist and the result is finite and >= 0. */
function spanMs(end: number | undefined, start: number | undefined): number | undefined {
  if (typeof end !== 'number' || typeof start !== 'number') return undefined
  const d = end - start
  return Number.isFinite(d) && d >= 0 ? d : undefined
}

/** decision delay: time the actor spent before signing (signedAt - offeredAt) */
export function decisionMs(t: TurnTiming | undefined): number | undefined {
  return spanMs(t?.signedAt, t?.offeredAt)
}

/** network latency: broadcast → counter-sign/landing observed (confirmedAt - broadcastAt) */
export function networkMs(t: TurnTiming | undefined): number | undefined {
  return spanMs(t?.confirmedAt, t?.broadcastAt)
}

/** whole-turn duration: offered → confirmed (confirmedAt - offeredAt) */
export function totalMs(t: TurnTiming | undefined): number | undefined {
  return spanMs(t?.confirmedAt, t?.offeredAt)
}

export interface EnvelopeSigner {
  address: Hex
  signMessage(a: { message: { raw: Hex } }): Promise<Hex>
}

const GENESIS: Hex = `0x${'00'.repeat(32)}`

/**
 * abi-structured: an on-chain adjudicator can recompute this digest and
 * ecrecover the envelope signature given (tableId, seq, prev, kind, bodyBytes).
 * Body payloads remain canonical-JSON bytes for now — the v1 ZkTable dispute
 * machine never reads bodies (responses are tx-authenticated), so per-kind abi
 * body codecs are deferred until a dispute path needs one.
 */
export function entryDigest(e: Omit<Envelope, 'sig' | 'from'>): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint64, bytes32, bytes32, bytes32'),
    [e.tableId, BigInt(e.seq), e.prev, keccak256(stringToHex(e.kind)), keccak256(stringToHex(JSON.stringify(e.body)))],
  ))
}

export async function makeEnvelope(
  signer: EnvelopeSigner,
  tableId: Hex,
  seq: number,
  prev: Hex,
  kind: string,
  body: unknown,
  timing?: TurnTiming,
): Promise<Envelope> {
  const partial = { tableId, seq, prev, kind, body }
  const sig = await signer.signMessage({ message: { raw: entryDigest(partial) } })
  // timing is appended to the wrapper AFTER the digest is computed and signed,
  // so it is provably outside the signed surface.
  const env: Envelope = { ...partial, from: signer.address, sig }
  if (timing) env.timing = timing
  return env
}

/** Attach/merge non-signed timing metadata onto an existing envelope without touching its digest. */
export function withTiming(e: Envelope, timing: TurnTiming): Envelope {
  return { ...e, timing: { ...e.timing, ...timing } }
}

export async function verifyEnvelope(e: Envelope): Promise<boolean> {
  try {
    const rec = await recoverMessageAddress({
      message: { raw: entryDigest(e) },
      signature: e.sig,
    })
    return rec.toLowerCase() === e.from.toLowerCase()
  } catch {
    return false
  }
}

export class Transcript {
  private _entries: Envelope[] = []
  head: Hex = GENESIS
  constructor(public tableId: Hex) {}

  get entries(): readonly Envelope[] {
    return this._entries
  }

  append(e: Envelope): void {
    if (e.tableId !== this.tableId) throw new Error('transcript: wrong table')
    if (e.seq !== this._entries.length)
      throw new Error(`transcript: seq must be ${this._entries.length}`)
    if (e.prev !== this.head) throw new Error('transcript: chain break (prev != head)')
    this._entries.push(e)
    this.head = keccak256(concat([this.head, entryDigest(e)]))
  }

  /** Full re-verification: chain links, seqs, signatures, signer membership. */
  async verify(parties: { player: Hex; house: Hex }): Promise<boolean> {
    let head: Hex = GENESIS
    const ok = new Set([parties.player.toLowerCase(), parties.house.toLowerCase()])
    for (const [i, e] of this._entries.entries()) {
      if (e.seq !== i || e.prev !== head || e.tableId !== this.tableId) return false
      if (!ok.has(e.from.toLowerCase())) return false
      if (!(await verifyEnvelope(e))) return false
      head = keccak256(concat([head, entryDigest(e)]))
    }
    return head === this.head
  }

  toJSON(): string {
    return JSON.stringify({ tableId: this.tableId, head: this.head, entries: this._entries })
  }

  static fromJSON(s: string): Transcript {
    const o = JSON.parse(s) as { tableId: unknown; head: unknown; entries: unknown }
    if (typeof o.tableId !== 'string' || !Array.isArray(o.entries))
      throw new Error('transcript: malformed JSON payload')
    const t = new Transcript(o.tableId as Hex)
    for (const e of o.entries) t.append(e as Envelope)   // re-derives head, validates chain/seq
    if (typeof o.head === 'string' && o.head !== t.head)
      throw new Error('transcript: serialized head does not match derived head')
    return t
  }
}
