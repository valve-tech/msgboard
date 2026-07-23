import { keccak256, type Hex } from 'viem'
import {
  type SessionState, signSessionState, verifySessionStateSig,
} from './sessionState'
import { buildSeedChain, verifyReveal, roundRandom } from './rng'
import { Transcript, makeEnvelope, withTiming, systemClock, type Clock } from './transcript'
import type { SessionConfig, PlayInput, Signer } from './session'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

/**
 * The round reveal that accompanies a ROUND co-sign request, letting the player independently
 * recompute the proposed transition (seed reveal → roundRandom → outcome → balances) BEFORE it
 * signs — exactly the inputs HouseSession.playRound uses. Carried out-of-band of the signed
 * SessionState (it is not part of the EIP-712 surface), so it never affects the co-signed digest.
 * Absent for OPEN (nonce 0), which has no round to reconstruct.
 */
export interface RoundProof<TParams> {
  serverSeed: Hex
  clientSeed: Hex
  stake: bigint
  params: TParams
}

/**
 * Abstracts the player↔house round-trip for one EIP-712 SessionState co-signature.
 *
 * The house side `request`s the player's half over the transport (passing the proposed
 * state WITHOUT any signature, plus the round reveal for ROUND states); the player side `serve`s
 * by verifying the proposed transition (seed reveal + recomputed outcome, exactly as
 * HouseSession.playRound does) and returning ONLY its own EIP-712 half. Neither side ever sees
 * the other's private key, and the player never holds the house's secret seed tip — it verifies
 * the revealed seed against the published commit.
 *
 * Tests supply an in-memory linked pair; a real deployment backs this with a board/transport.
 */
export interface CoSignTransport {
  /** house → player: ask the player to co-sign `stateNoSig` (with `proof` for ROUND); resolves with the player's EIP-712 half. */
  request(stateNoSig: SessionState, proof?: RoundProof<unknown>): Promise<Hex>
  /** player side: register the signer invoked for each incoming request. */
  serve(sign: (s: SessionState, proof?: RoundProof<unknown>) => Promise<Hex>): void
}

interface SigPair { player: Hex; house: Hex }

/**
 * Drive open + one round as the HOUSE, holding only the house key. Wherever the in-process
 * HouseSession would invoke the player signer, this `request`s the player's EIP-712 half over
 * the transport instead. Produces a retained Transcript whose OPEN/ROUND envelopes, body shapes,
 * `gameStateHash`, and both co-signatures are constructed identically to HouseSession's — so
 * `verifyFinishedSession` / `replaySession` accept it. Returns the transcript JSON.
 *
 * Envelope (transport-auth) signatures are produced with the house key locally; `verifyFinishedSession`
 * only requires each envelope's `from` to be a session party, and the EIP-712 STATE co-signatures —
 * the consensus surface — are still split (player signs only the player half, house only the house half).
 */
export async function runHouseSide<TParams>(
  cfg: SessionConfig<TParams>,
  transport: CoSignTransport,
  play: PlayInput<TParams>,
): Promise<string> {
  const now: Clock = cfg.clock ?? systemClock
  const house: Signer = cfg.house
  const chain = buildSeedChain(cfg.seedTip, cfg.chainLength)
  const transcript = new Transcript(cfg.tableId)

  // Co-sign a state: house signs its half locally, player signs its half over the transport.
  const coSign = async (s: SessionState, proof?: RoundProof<TParams>): Promise<SigPair> => {
    const player = await transport.request(s, proof as RoundProof<unknown> | undefined)
    const houseHalf = await signSessionState(house, cfg.domain, s)
    if (!(await verifySessionStateSig(cfg.player.address, cfg.domain, s, player))) {
      throw new Error('coSign: player half did not recover to the player address')
    }
    return { player, house: houseHalf }
  }

  // ---- OPEN (nonce 0) ----
  const openOfferedAt = now()
  const openState: SessionState = {
    tableId: cfg.tableId,
    nonce: 0n,
    balancePlayer: cfg.openBalances.player,
    balanceHouse: cfg.openBalances.house,
    settlementMode: cfg.settlementMode,
    gameId: cfg.game.gameId,
    gameStateHash: ZERO32,
    rngCommit: chain.commit,
  }
  const openSigs = await coSign(openState)
  const openSignedAt = now()
  const openBroadcastAt = now()
  const openEnv = await makeEnvelope(house, cfg.tableId, 0, transcript.head, 'OPEN', {
    rngCommit: chain.commit,
    settlementMode: openState.settlementMode,
    gameId: openState.gameId,
    balances: { player: openState.balancePlayer.toString(), house: openState.balanceHouse.toString() },
    sigs: openSigs,
  })
  const openConfirmedAt = now()
  transcript.append(withTiming(openEnv, {
    offeredAt: openOfferedAt, signedAt: openSignedAt, broadcastAt: openBroadcastAt, confirmedAt: openConfirmedAt,
  }))

  // ---- ROUND (nonce 1) ----
  const roundOfferedAt = now()
  const roundIndex = 1n
  const serverSeed = chain.seeds[Number(roundIndex)]
  if (!serverSeed) throw new Error('coSign: seed chain exhausted')
  const priorLink = chain.seeds[Number(roundIndex) - 1]!
  if (!verifyReveal(priorLink, serverSeed)) throw new Error('coSign: bad seed reveal')

  const raw = roundRandom(serverSeed, play.clientSeed, roundIndex)
  const outcome = cfg.game.settleRound(play.stake, play.params, raw)
  const gameStateHash = keccak256(cfg.game.encodeRound(play.stake, play.params, raw))

  const next: SessionState = {
    ...openState,
    nonce: roundIndex,
    balancePlayer: openState.balancePlayer + outcome.playerDelta,
    balanceHouse: openState.balanceHouse - outcome.playerDelta,
    gameStateHash,
  }
  if (next.balancePlayer < 0n || next.balanceHouse < 0n) throw new Error('coSign: balance underflow')

  const roundSigs = await coSign(next, {
    serverSeed, clientSeed: play.clientSeed, stake: play.stake, params: play.params,
  })
  const roundSignedAt = now()
  const roundBroadcastAt = now()
  // Mirror HouseSession: the ROUND body carries the full round preimage so the transcript
  // is independently re-derivable. Envelope is signed by the house key (transport-auth only).
  const roundEnv = await makeEnvelope(house, cfg.tableId, transcript.entries.length, transcript.head, 'ROUND', {
    round: Number(roundIndex),
    stake: play.stake.toString(),
    clientSeed: play.clientSeed,
    serverSeed,
    params: serializeParams(play.params),
    outcome: { win: outcome.win, playerDelta: outcome.playerDelta.toString(), multiplierX100: outcome.multiplierX100.toString() },
    sigs: roundSigs,
  })
  const roundConfirmedAt = now()
  transcript.append(withTiming(roundEnv, {
    offeredAt: roundOfferedAt, signedAt: roundSignedAt, broadcastAt: roundBroadcastAt, confirmedAt: roundConfirmedAt,
  }))

  return transcript.toJSON()
}

/**
 * The browser counterpart: holds only the player key, `serve`s each incoming co-sign request by
 * independently re-deriving the proposed state from the committed seed chain (seed reveal +
 * recomputed outcome, exactly as HouseSession.playRound verifies before signing) and returning
 * its EIP-712 half. It signs nothing it cannot reconstruct from the committed inputs.
 *
 * `cfg.houseRemote` marks that the house key lives across the transport (Omit<'house'>).
 */
export async function runPlayerSide<TParams>(
  cfg: Omit<SessionConfig<TParams>, 'house'> & { houseRemote: true; clientSeed: Hex },
  transport: CoSignTransport,
): Promise<void> {
  const player: Signer = cfg.player
  // The player tracks the running state across requests so it can re-derive each transition from
  // the PRIOR state it already accepted — never from the house's secret seed tip. It knows only
  // the published commit (carried on the OPEN state's rngCommit) and the per-round reveals.
  let prior: SessionState | undefined
  await new Promise<void>((resolve, reject) => {
    let signed = 0
    const total = 2 // OPEN + one ROUND (chainLength 1)
    transport.serve(async (s: SessionState, proof?: RoundProof<unknown>): Promise<Hex> => {
      try {
        verifyProposedState(cfg, prior, s, proof as RoundProof<TParams> | undefined)
        prior = s
        const half = await signSessionState(player, cfg.domain, s)
        if (++signed >= total) resolve()
        return half
      } catch (err) {
        reject(err as Error)
        throw err
      }
    })
  })
}

/**
 * Re-derive and check a proposed state BEFORE the player signs — exactly the invariants
 * HouseSession.playRound enforces, but with NO access to the house's secret seed tip:
 *  - OPEN (nonce 0): zero gameStateHash, balances match config; record its rngCommit.
 *  - ROUND (nonce 1): the revealed serverSeed must hash to the committed rngCommit, the outcome is
 *    recomputed from roundRandom(serverSeed, clientSeed, nonce) via the game's own settleRound, and
 *    the proposed balances + gameStateHash must match that recomputation exactly.
 * Throws on any mismatch so the player signs nothing it cannot independently reconstruct.
 */
function verifyProposedState<TParams>(
  cfg: Omit<SessionConfig<TParams>, 'house'> & { clientSeed: Hex },
  prior: SessionState | undefined,
  s: SessionState,
  proof: RoundProof<TParams> | undefined,
): void {
  if (s.tableId !== cfg.tableId) throw new Error('player: wrong tableId')
  if (s.gameId !== cfg.game.gameId) throw new Error('player: wrong gameId')
  if (s.settlementMode !== cfg.settlementMode) throw new Error('player: wrong settlementMode')

  if (s.nonce === 0n) {
    if (prior) throw new Error('player: duplicate OPEN')
    if (s.gameStateHash !== ZERO32) throw new Error('player: open state must have zero gameStateHash')
    if (s.balancePlayer !== cfg.openBalances.player || s.balanceHouse !== cfg.openBalances.house) {
      throw new Error('player: open balances do not match config')
    }
    return
  }
  if (s.nonce !== 1n) throw new Error('player: unexpected nonce (chainLength 1 allows only round 1)')
  if (!prior || prior.nonce !== 0n) throw new Error('player: ROUND before OPEN')
  if (s.rngCommit !== prior.rngCommit) throw new Error('player: rngCommit changed mid-session')
  if (!proof) throw new Error('player: ROUND request missing reveal proof')

  // ANTI-HOUSE-BIAS (the funds-safety linchpin): the round entropy is roundRandom(serverSeed,
  // clientSeed, nonce). The house already controls serverSeed (its committed chain), so if it could
  // also choose clientSeed it would control BOTH inputs and could grind a player-losing outcome that
  // still recomputes cleanly below. The player therefore signs ONLY when the round used the exact
  // clientSeed IT committed — never a house-substituted one. Combined with serverSeed being fixed by
  // the open-time rngCommit (verifyReveal) and the player's seed being unknown to the house at commit
  // time, neither party can bias the draw. (chainLength 1 ⇒ a single committed clientSeed.)
  if (proof.clientSeed !== cfg.clientSeed) throw new Error('player: clientSeed is not the one the player committed')

  // Seed reveal: the revealed seed must hash to the published commit (no tip needed).
  if (!verifyReveal(prior.rngCommit, proof.serverSeed)) throw new Error('player: bad seed reveal')

  // Recompute the round from the same inputs and rules HouseSession used.
  const raw = roundRandom(proof.serverSeed, proof.clientSeed, s.nonce)
  const outcome = cfg.game.settleRound(proof.stake, proof.params, raw)
  const expectedGameStateHash = keccak256(cfg.game.encodeRound(proof.stake, proof.params, raw))
  if (s.gameStateHash !== expectedGameStateHash) throw new Error('player: gameStateHash mismatch')
  if (s.balancePlayer !== prior.balancePlayer + outcome.playerDelta) throw new Error('player: player balance mismatch')
  if (s.balanceHouse !== prior.balanceHouse - outcome.playerDelta) throw new Error('player: house balance mismatch')
}

/**
 * Serialize each param field into a self-describing string (`b:` bigint, `j:` JSON) — byte-identical
 * to HouseSession's private serializeParams, so deserializeParams in verifyFinishedSession round-trips.
 */
function serializeParams(p: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    out[k] = typeof v === 'bigint' ? `b:${v}` : `j:${JSON.stringify(v)}`
  }
  return out
}
