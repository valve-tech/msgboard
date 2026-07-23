import * as viem from 'viem'
import { coinflip } from '@msgboard/coinflip'
import { raffle, type RaffleEntry } from '@msgboard/raffle'
import { raffleDraw } from '@msgboard/games-core'

/**
 * The verify-the-draw derivations: the cross-layer parity assertions (proved by the e2e suite
 * and the parity gate) as pure functions a screen can render. All arithmetic goes through the
 * game packages — nothing is recomputed locally, so a ✓ here IS the parity guarantee.
 */

export type CoinFlipVerification = {
  offChainWinner: viem.Hex
  winningSide: 'heads' | 'tails'
  matches: boolean
}

export const verifyCoinFlip = (input: {
  seed: viem.Hex
  heads: viem.Hex
  tails: viem.Hex
  onChainWinner: viem.Hex
}): CoinFlipVerification => {
  const outcome = coinflip.settle(
    // params are irrelevant to settle's arithmetic; supply the minimal valid shape
    { stake: 1n, validatorSubset: [] },
    [
      { player: input.heads, side: 'heads' },
      { player: input.tails, side: 'tails' },
    ],
    input.seed,
  )
  return {
    offChainWinner: outcome.winner,
    winningSide: outcome.winningSide,
    matches: viem.isAddressEqual(outcome.winner, input.onChainWinner),
  }
}

export type RaffleVerification = {
  draw: bigint
  offChainTicket: bigint | null
  offChainPlayer?: viem.Hex
  matches: boolean
}

export const verifyRaffle = (input: {
  seed: viem.Hex
  entries: RaffleEntry[]
  /** The contract's rounds[roundId].bestTicket — zero when nothing revealed. */
  onChainBestTicket: bigint
}): RaffleVerification => {
  const outcome = raffle.settle(
    { stake: 1n, threshold: 1n, period: 1n, validatorSubset: [] },
    input.entries,
    input.seed,
  )
  return {
    draw: raffleDraw(input.seed),
    offChainTicket: outcome?.ticketId ?? null,
    offChainPlayer: outcome?.player,
    matches: (outcome?.ticketId ?? 0n) === input.onChainBestTicket,
  }
}
