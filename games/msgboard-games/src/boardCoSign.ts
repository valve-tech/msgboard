/**
 * Board-backed CoSignTransport.
 *
 * The in-process co-sign uses an in-memory linked pair (memoryCoSignPair). A real split deployment
 * carries the EXACT same `request`/`serve` round-trip as board messages: the house posts a
 * `cosign-req` (the proposed SessionState + the round reveal), the player verifies it independently
 * (verifyProposedState, in runPlayerSide) and posts back a `cosign-rep` carrying ONLY its EIP-712
 * half. Neither key ever crosses the wire; the consensus signatures stay split.
 *
 * Works over any `Transport` (send + onMessage). For a PULL transport (MsgBoardTransport.poll), pass
 * a `poll` driver: the house `request()` loops it while awaiting the reply, and `servePlayer` runs it
 * in a background loop. For a PUSH transport (LocalTransport) no poll is needed.
 */
import type { Hex } from 'viem'
import type { SessionState } from './sessionState'
import type { CoSignTransport, RoundProof } from './coSignTransport'
import type { Transport } from './transport'

interface CoSignReqMsg { kind: 'cosign-req'; reqId: string; state: SessionState; proof?: RoundProof<unknown> }
interface CoSignRepMsg { kind: 'cosign-rep'; reqId: string; sig: Hex }

// ── bigint-safe wire codec ────────────────────────────────────────────────────
// SessionState (nonce, balances) and the round proof (stake, params.targetX100, …) carry bigints.
// A real board JSON-encodes messages, and JSON.stringify throws on bigint — so we deep-tag bigints
// as {$b:"<dec>"} before send and restore them on receive. Restoration is exact, so the reconstructed
// SessionState hashes/recovers identically to the original (the EIP-712 signature stays valid).
//
// Exported so the wider board session protocol (open/round messages, which also carry bigint
// escrow/stake/params) reuses the SAME codec — one encoder for every message that crosses the wire.
export function toWire(v: unknown): unknown {
  if (typeof v === 'bigint') return { $b: v.toString() }
  if (Array.isArray(v)) return v.map(toWire)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toWire(val)
    return out
  }
  return v
}
export function fromWire(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $b?: unknown }).$b === 'string') {
    return BigInt((v as { $b: string }).$b)
  }
  if (Array.isArray(v)) return v.map(fromWire)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = fromWire(val)
    return out
  }
  return v
}

/** One reqId per co-signed state. tableId+nonce is unique within a session (nonce 0 open, 1.. rounds). */
function reqIdOf(s: SessionState): string {
  return `${s.tableId}:${s.nonce}`
}

const isReq = (m: unknown): m is CoSignReqMsg =>
  !!m && (m as CoSignReqMsg).kind === 'cosign-req' && typeof (m as CoSignReqMsg).reqId === 'string'
const isRep = (m: unknown): m is CoSignRepMsg =>
  !!m && (m as CoSignRepMsg).kind === 'cosign-rep' && typeof (m as CoSignRepMsg).reqId === 'string' && typeof (m as CoSignRepMsg).sig === 'string'

export interface BoardCoSignOpts {
  /** For a pull transport, the poll fn to drive (MsgBoardTransport.poll). Omit for push transports. */
  poll?: () => Promise<void>
  /** Poll cadence + request timeout (ms). */
  pollMs?: number
  timeoutMs?: number
  /**
   * Player-end only: when set, ignore any `cosign-req` whose reqId is not for this table.
   * A real board category is SHARED across tables; without this filter a player would try to
   * co-sign another table's request. reqId is `${tableId}:${nonce}`, so we match the prefix.
   */
  tableId?: Hex
  /**
   * Player-end only: invoked AFTER the player signs a state, BEFORE the reply is posted — the same
   * contract as the in-memory pair's onAccept. Lets the caller capture the co-signed ROUND state
   * (nonce > 0) so it can derive a receipt from the state both parties actually signed.
   */
  onAccept?: (state: SessionState, proof?: RoundProof<unknown>) => void
}

/**
 * HOUSE end: implements `request()` over the board. Sends a `cosign-req` and resolves with the
 * player's half once the matching `cosign-rep` arrives. `serve()` is unsupported on this end.
 */
export function makeBoardHouseCoSign(transport: Transport, opts: BoardCoSignOpts = {}): CoSignTransport {
  const pollMs = opts.pollMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 120_000
  const pending = new Map<string, (sig: Hex) => void>()

  transport.onMessage((raw) => {
    if (isRep(raw)) pending.get(raw.reqId)?.(raw.sig)
  })

  const sendReq = (reqId: string, state: SessionState, proof?: RoundProof<unknown>) =>
    transport.send(toWire({ kind: 'cosign-req', reqId, state, proof }))

  return {
    async request(state: SessionState, proof?: RoundProof<unknown>): Promise<Hex> {
      const reqId = reqIdOf(state)
      let settled = false
      const reply = new Promise<Hex>((resolve, reject) => {
        pending.set(reqId, (sig) => { settled = true; pending.delete(reqId); resolve(sig) })
        setTimeout(() => {
          if (!settled) { pending.delete(reqId); reject(new Error(`boardCoSign: timed out awaiting player half for ${reqId}`)) }
        }, timeoutMs)
      })
      await sendReq(reqId, state, proof)
      // Drive polling on a pull transport until the reply lands (or the timeout rejects).
      if (opts.poll) {
        void (async () => {
          while (!settled) {
            try { await opts.poll!() } catch { /* transient poll failure — keep trying until timeout */ }
            if (settled) break
            await new Promise((r) => setTimeout(r, pollMs))
          }
        })()
      }
      return reply
    },
    serve() { throw new Error('boardCoSign: house end does not serve') },
  }
}

export interface BoardPlayerCoSign extends CoSignTransport {
  /** Begin processing inbound `cosign-req`s on a pull transport. Returns a stop fn. No-op for push. */
  startServing(): () => void
}

/**
 * PLAYER end: implements `serve()` over the board. For each inbound `cosign-req` it invokes the
 * registered signer (which independently re-derives + verifies the state before signing) and posts a
 * `cosign-rep` with only its half. `request()` is unsupported on this end.
 */
export function makeBoardPlayerCoSign(transport: Transport, opts: BoardCoSignOpts = {}): BoardPlayerCoSign {
  const pollMs = opts.pollMs ?? 1000
  const tableFilter = opts.tableId?.toLowerCase()
  let signer: ((s: SessionState, proof?: RoundProof<unknown>) => Promise<Hex>) | undefined
  const answered = new Set<string>()
  const buffered: CoSignReqMsg[] = [] // cosign-reqs that arrived before serve() registered a signer

  /** reqId is `${tableId}:${nonce}`; on a shared board category, only handle this table's reqs. */
  const forThisTable = (reqId: string) =>
    !tableFilter || reqId.toLowerCase().startsWith(`${tableFilter}:`)

  const handle = (req: CoSignReqMsg) => {
    if (!forThisTable(req.reqId)) return // a different table's request on the shared category — not ours
    if (answered.has(req.reqId)) return // idempotent: never double-answer a reqId
    answered.add(req.reqId)
    void (async () => {
      try {
        const sig = await signer!(req.state, req.proof)
        // Notify the caller of the accepted state BEFORE posting the reply, so a ROUND-state capture
        // races ahead of the house seeing the signature (mirrors the in-memory pair's onAccept).
        opts.onAccept?.(req.state, req.proof)
        await transport.send({ kind: 'cosign-rep', reqId: req.reqId, sig } satisfies CoSignRepMsg)
      } catch {
        // A refusal (bad state / wrong clientSeed) means the player signs nothing; the house side
        // times out. Allow a retry by clearing the answered mark.
        answered.delete(req.reqId)
      }
    })()
  }

  transport.onMessage((raw) => {
    const msg = fromWire(raw) // restore bigints in state/proof before verifying + signing
    if (!isReq(msg)) return
    if (!signer) { buffered.push(msg); return } // hold until serve() registers a signer
    handle(msg)
  })

  return {
    request() { throw new Error('boardCoSign: player end does not request') },
    serve(sign) {
      signer = sign
      while (buffered.length) handle(buffered.shift()!) // drain anything that arrived pre-serve
    },
    startServing(): () => void {
      if (!opts.poll) return () => {}
      let running = true
      void (async () => {
        while (running) {
          try { await opts.poll!() } catch { /* transient */ }
          await new Promise((r) => setTimeout(r, pollMs))
        }
      })()
      return () => { running = false }
    },
  }
}
