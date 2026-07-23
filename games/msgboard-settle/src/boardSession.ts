/**
 * boardSession.ts — the player side of a split-key board session, framework-agnostic.
 *
 * This is the production counterpart to the in-memory `buildCoSignPair` + `makeInMemoryHouseDriver`
 * demo. It carries the EXACT same co-sign round-trip over a real MsgBoard category instead of an
 * in-process queue. The web `useSession` hook wires this into React; the house-service E2E drives it
 * directly against the real `startHouse`. One module, two consumers, so the wire path is tested.
 *
 * It exposes three operations against the house:
 *   - `requestOpen(...)`  → post an open-request, await the house-signed OpenTerms (for the on-chain
 *                           `open(terms, houseSig)` call). The grant NEVER carries the seed chain.
 *   - `playerT`           → the co-sign transport `runPlayerSide(cfg, playerT)` serves over; the
 *                           house drives OPEN (nonce 0) + ROUND (nonce 1) co-signing across it.
 *   - `houseDriver(...)`  → post the round-request (revealing clientSeed), await the finished
 *                           transcript the house posts back once both halves are co-signed.
 *
 * SECURITY: clientSeed is revealed ONLY in `houseDriver` (round time), never in `requestOpen`
 * (open time). `playerT` is tableId-scoped so a shared board category never cross-signs tables.
 */
import type { Hex } from 'viem'
import {
  MsgBoardTransport,
  makeBoardPlayerCoSign,
  toWire,
  fromWire,
  type BoardClient,
  type BoardPlayerCoSign,
  type SessionState,
  type RoundProof,
} from '@msgboard/games'
import type { OpenTerms } from './openTerms'
import {
  houseCategory,
  isOpenGrant,
  isOpenDecline,
  isRoundTranscript,
  isRoundDecline,
  sameTable,
  type OpenRequestMsg,
  type RoundRequestMsg,
} from './boardProtocol'

export interface BoardPlayerSessionOpts {
  board: BoardClient
  chainId: number
  tableId: Hex
  /** Poll cadence (ms) for the request/response and co-sign channels. Default 1000. */
  pollMs?: number
  /** How long to wait for a house response before rejecting (ms). Default 120000. */
  timeoutMs?: number
  /**
   * Invoked after the player co-signs a state (OPEN then ROUND), before the reply is posted. The
   * web hook uses this to capture the co-signed ROUND state (nonce > 0) so the on-screen receipt is
   * derived from the state both parties signed — never a fabricated literal.
   */
  onAccept?: (state: SessionState, proof?: RoundProof<unknown>) => void
}

/** What the round driver needs from the caller to post a round-request. */
export interface BoardRoundInput<TParams> {
  stake: bigint
  params: TParams
  clientSeed: Hex
  playerAddress: Hex
}

export interface BoardPlayerSession {
  /** The co-sign transport: `runPlayerSide(cfg, session.playerT)` serves the house's requests. */
  playerT: BoardPlayerCoSign
  /** Begin draining the co-sign channel (call once, after launching runPlayerSide). Returns a stop fn. */
  startServing(): () => void
  /**
   * Post an open-request (clientSeedCommit only) and await the house's signed OpenTerms.
   * Used to fund the on-chain `open(terms, houseSig)` before any round.
   */
  requestOpen(req: Omit<OpenRequestMsg, 'kind'>): Promise<{ terms: OpenTerms; houseSig: Hex }>
  /**
   * Post the round-request (revealing clientSeed) and await the finished co-signed transcript.
   * The OPEN+ROUND co-signing itself happens over `playerT` while this awaits.
   */
  houseDriver<TParams>(input: BoardRoundInput<TParams>): Promise<string>
}

export function makeBoardPlayerSession(opts: BoardPlayerSessionOpts): BoardPlayerSession {
  const { board, chainId, tableId } = opts
  const pollMs = opts.pollMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 120_000
  const cat = houseCategory(chainId)

  // Two transports on the SAME shared category: `rpc` carries open/round request-response, `cosignT`
  // carries the co-sign halves. Each MsgBoardTransport holds a single handler, hence two instances.
  const rpc = new MsgBoardTransport(board, cat)
  const cosignT = new MsgBoardTransport(board, cat)
  const playerT = makeBoardPlayerCoSign(cosignT, { tableId, poll: () => cosignT.poll(), pollMs, onAccept: opts.onAccept })

  type Pending<T> = { resolve: (v: T) => void; reject: (e: unknown) => void }
  let openPending: Pending<{ terms: OpenTerms; houseSig: Hex }> | undefined
  let roundPending: Pending<string> | undefined

  rpc.onMessage((raw) => {
    const msg = fromWire(raw)
    if (isOpenGrant(msg) && sameTable(msg.tableId, tableId)) {
      openPending?.resolve({ terms: msg.terms, houseSig: msg.houseSig })
    } else if (isOpenDecline(msg) && sameTable(msg.tableId, tableId)) {
      openPending?.reject(new Error(`house declined open: ${msg.reason}`))
    } else if (isRoundTranscript(msg) && sameTable(msg.tableId, tableId)) {
      roundPending?.resolve(msg.transcriptJson)
    } else if (isRoundDecline(msg) && sameTable(msg.tableId, tableId)) {
      roundPending?.reject(new Error(`house declined round: ${msg.reason}`))
    }
  })

  /**
   * Post `out` then drive `rpc.poll()` until `set(pending)`'s promise settles or the timeout fires.
   * Self-driving so it works before `startServing()` (open handshake) and during it (round). `clear`
   * nulls the single pending slot on settle, so a guard can reject overlapping calls without
   * permanently blocking sequential reuse.
   */
  async function exchange<T>(out: unknown, set: (p: Pending<T>) => void, clear: () => void): Promise<T> {
    let settled = false
    const finish = () => { settled = true; clear() }
    const result = new Promise<T>((resolve, reject) => {
      set({
        resolve: (v) => { finish(); resolve(v) },
        reject: (e) => { finish(); reject(e) },
      })
      setTimeout(() => {
        if (!settled) { finish(); reject(new Error('boardSession: timed out awaiting house response')) }
      }, timeoutMs)
    })
    await rpc.send(toWire(out))
    void (async () => {
      while (!settled) {
        try { await rpc.poll() } catch { /* transient poll failure — keep trying until timeout */ }
        if (settled) break
        await new Promise((r) => setTimeout(r, pollMs))
      }
    })()
    return result
  }

  return {
    playerT,
    startServing: () => playerT.startServing(),

    requestOpen(req) {
      if (openPending) return Promise.reject(new Error('boardSession: requestOpen already in flight'))
      return exchange<{ terms: OpenTerms; houseSig: Hex }>(
        { kind: 'open-request', ...req } satisfies OpenRequestMsg,
        (p) => { openPending = p },
        () => { openPending = undefined },
      )
    },

    houseDriver<TParams>(input: BoardRoundInput<TParams>) {
      if (roundPending) return Promise.reject(new Error('boardSession: houseDriver round already in flight'))
      const roundReq: RoundRequestMsg = {
        kind: 'round-request',
        tableId,
        clientSeed: input.clientSeed,
        stake: input.stake,
        params: input.params,
        playerAddress: input.playerAddress,
        // playerKey == playerAddress today (the player signs co-sigs with its own wallet key). The
        // house uses this as the player address for co-sig verification (see houseLoop sessionCfg).
        playerKey: input.playerAddress,
      }
      return exchange<string>(roundReq, (p) => { roundPending = p }, () => { roundPending = undefined })
    },
  }
}
