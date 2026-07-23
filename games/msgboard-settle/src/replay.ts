import { keccak256, type Hex } from 'viem'
import {
  type SessionState, type GameDomain, type Game,
  roundRandom, verifyReveal, verifySessionStateSig,
  Transcript,
} from '@msgboard/games'
import { type CoSignedState } from './settlement'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export interface ReplayContext<TParams> {
  parties: { player: Hex; house: Hex }
  commit: Hex
  game: Game<TParams>
  domain: GameDomain
  settlementMode: number
}

export interface ReplayResult {
  open: CoSignedState
  final: CoSignedState
  rounds: number
}

interface SigPair { player: Hex; house: Hex }
interface OpenBody { rngCommit?: Hex; settlementMode?: number; gameId?: number; balances?: { player?: string; house?: string }; sigs?: SigPair }
interface RoundBody { round: number; stake: string; clientSeed: Hex; serverSeed: Hex; params: Record<string, string>; outcome: { win: boolean; playerDelta: string; multiplierX100: string }; sigs?: SigPair }

/**
 * Inverse of coSignTransport's serializeParams — restores each field to its original type.
 * Tags: `b:<n>` → BigInt; `j:<json>` → JSON.parse. Matches the encoding in session.ts's
 * serializeParams/deserializeParams so EscrowedSettlement.buildSettle can round-trip any
 * param shape (bigint targets, string risk, number rows, number[] keno picks).
 */
function deserializeParams<TParams>(raw: Record<string, string>): TParams {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v.startsWith('b:')) out[k] = BigInt(v.slice(2))
    else if (v.startsWith('j:')) out[k] = JSON.parse(v.slice(2))
    else out[k] = BigInt(v) // legacy: bare bigint string (no prefix)
  }
  return out as TParams
}

/** Re-derive the open (nonce 0) and final co-signed SessionStates from the retained transcript,
 *  recomputing every round from (serverSeed, clientSeed, nonce) and verifying both EIP-712
 *  co-signatures at every step (spec §2 — the retained transcript alone proves the result).
 *  Throws on any mismatch so settlement never builds calldata from a tampered transcript. */
export async function replaySession<TParams>(transcriptJson: string, ctx: ReplayContext<TParams>): Promise<ReplayResult> {
  const t = Transcript.fromJSON(transcriptJson)
  if (!(await t.verify(ctx.parties))) throw new Error('replay: transcript chain/sig verify failed')

  const openEnv = t.entries.find((e) => e.kind === 'OPEN')
  if (!openEnv) throw new Error('replay: no OPEN entry')
  const ob = openEnv.body as OpenBody
  if (ob.rngCommit !== ctx.commit) throw new Error('replay: open rngCommit mismatch')
  if (!ob.balances || ob.balances.player === undefined || ob.balances.house === undefined) throw new Error('replay: open balances missing')
  if (!ob.sigs) throw new Error('replay: open sigs missing')
  if (Number(ob.settlementMode ?? 0) !== ctx.settlementMode) throw new Error('replay: settlementMode mismatch')

  let state: SessionState = {
    tableId: t.tableId,
    nonce: 0n,
    balancePlayer: BigInt(ob.balances.player),
    balanceHouse: BigInt(ob.balances.house),
    settlementMode: ctx.settlementMode,
    gameId: ctx.game.gameId,
    gameStateHash: ZERO32,
    rngCommit: ctx.commit,
  }
  await assertPair(state, ob.sigs, ctx)
  const open: CoSignedState = { state, sigPlayer: ob.sigs.player, sigHouse: ob.sigs.house }

  let final: CoSignedState = open
  let priorLink: Hex = ctx.commit
  let rounds = 0
  for (const e of t.entries) {
    if (e.kind !== 'ROUND') continue
    const b = e.body as RoundBody
    if (!b.sigs) throw new Error('replay: round sigs missing')
    if (!verifyReveal(priorLink, b.serverSeed)) throw new Error('replay: bad seed reveal')
    priorLink = b.serverSeed
    const raw = roundRandom(b.serverSeed, b.clientSeed, BigInt(b.round))
    const params = deserializeParams<TParams>(b.params)
    const outcome = ctx.game.settleRound(BigInt(b.stake), params, raw)
    if (
      outcome.win !== b.outcome.win ||
      outcome.playerDelta.toString() !== b.outcome.playerDelta ||
      outcome.multiplierX100.toString() !== b.outcome.multiplierX100
    ) throw new Error('replay: recomputed outcome mismatch')
    state = {
      ...state,
      nonce: BigInt(b.round),
      balancePlayer: state.balancePlayer + outcome.playerDelta,
      balanceHouse: state.balanceHouse - outcome.playerDelta,
      gameStateHash: keccak256(ctx.game.encodeRound(BigInt(b.stake), params, raw)),
    }
    if (state.balancePlayer < 0n || state.balanceHouse < 0n) throw new Error('replay: balance underflow')
    await assertPair(state, b.sigs, ctx)
    final = { state, sigPlayer: b.sigs.player, sigHouse: b.sigs.house }
    rounds++
  }
  if (rounds === 0) throw new Error('replay: no ROUND entries to settle')
  return { open, final, rounds }
}

async function assertPair<TParams>(state: SessionState, sigs: SigPair, ctx: ReplayContext<TParams>): Promise<void> {
  if (!(await verifySessionStateSig(ctx.parties.player, ctx.domain, state, sigs.player))) throw new Error(`replay: bad player sig at nonce ${state.nonce}`)
  if (!(await verifySessionStateSig(ctx.parties.house, ctx.domain, state, sigs.house))) throw new Error(`replay: bad house sig at nonce ${state.nonce}`)
}
