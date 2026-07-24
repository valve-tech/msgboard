import type { Hex } from 'viem'
import type { GameDomain, StateSigner, Game } from '@msgboard/games'
import { escrowFor } from '@msgboard/games'
import { signOpenTerms, paramsHashForGame, type OpenTerms } from '@msgboard/settle'

export type OpenRequest = {
  tableId: Hex; player: Hex; playerKey: Hex; gameId: number
  /** Raw game params for the chosen gameId (the board codec transports bigints). reviewOpen passes
   *  these straight to the routed game's maxMultiplierX100 to size escrow. */
  params: unknown
  stake: bigint
  /** keccak256(clientSeed): the player's entropy COMMITMENT, not the seed itself. Sending only the
   *  commit forces the house to build its server seed chain (ctx.rngCommit) blind, so it cannot grind
   *  its tip against a known clientSeed to bias the roll. The seed is revealed at round time. */
  clientSeedCommit: Hex
}
export type Limits = { maxEscrowHouse: bigint; clockBlocks: bigint; expiryBlocks: bigint }

export async function reviewOpen(
  req: OpenRequest,
  // rngCommit is the HOUSE's freshly-built seed-chain commit (seeds[0]); it must be generated WITHOUT
  // knowledge of the player's clientSeed (the request carries only clientSeedCommit), or the house
  // could grind its tip to force a loss. Never sourced from the player.
  // game is the routed Game for req.gameId — its maxMultiplierX100(params) is the universal escrow
  // ceiling primitive; it must be the SAME game the table opens under and later co-signs its round.
  ctx: { houseKey: StateSigner; domain: GameDomain; headBlock: bigint; limits: Limits; rngCommit: Hex; game: Game<unknown> },
): Promise<{ ok: true; terms: OpenTerms; houseSig: Hex } | { ok: false; reason: string }> {
  if (req.stake <= 0n) return { ok: false, reason: 'non-positive stake' }
  // The escrow ceiling is game-routed: maxMultiplierX100 throws on invalid params for that game
  // (e.g. a dice target out of range), which we surface as a decline rather than a crash.
  let maxMult: bigint
  try {
    maxMult = ctx.game.maxMultiplierX100(req.params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'invalid params: ' + message }
  }
  const { escrowPlayer, escrowHouse } = escrowFor(req.stake, maxMult)
  if (escrowHouse > ctx.limits.maxEscrowHouse) return { ok: false, reason: 'escrow exceeds house cap' }
  // paramsHash is routed by gameId over the FULL canonical per-game params encoding — the exact bytes
  // GamePayouts._<game> decodes and settleWithSeeds checks (keccak256(params) == paramsHash). This is
  // what lets non-single-target games (plinko/keno/roulette/…) open at all; a single-uint256 hash only
  // ever matched dice/limbo/crash. Malformed params or an unsupported gameId decline, never crash.
  let paramsHash: Hex
  try {
    paramsHash = paramsHashForGame(req.gameId, req.params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'invalid params: ' + message }
  }
  const terms: OpenTerms = {
    tableId: req.tableId, player: req.player, playerKey: req.playerKey,
    escrowPlayer, escrowHouse, gameId: req.gameId, rngCommit: ctx.rngCommit,
    clockBlocks: ctx.limits.clockBlocks, expiry: ctx.headBlock + ctx.limits.expiryBlocks,
    clientSeedCommit: req.clientSeedCommit,
    paramsHash,
  }
  const houseSig = await signOpenTerms(ctx.houseKey, ctx.domain, terms)
  return { ok: true, terms, houseSig }
}
