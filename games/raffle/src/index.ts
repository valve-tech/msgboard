import * as viem from 'viem'
import { type Game, type Preset, raffleDraw } from '@msgboard/games-core'

export type RaffleParams = {
  stake: bigint
  threshold: bigint
  period: bigint
  validatorSubset: viem.Hex[]
}
export type RaffleEntry = {
  ticketId: bigint
  player: viem.Hex
  guess: bigint
  committedAtBlock: bigint
  revealed: boolean
}
export type RaffleOutcome = { ticketId: bigint; player: viem.Hex; guess: bigint; distance: bigint }

const MIN_SUBSET = 3

const distance = (guess: bigint, draw: bigint): bigint => (guess > draw ? guess - draw : draw - guess)

export const raffle: Game<RaffleParams, RaffleEntry, RaffleOutcome | null> = {
  parseParams: (raw) => {
    const p = raw as Partial<RaffleParams>
    if (typeof p.stake !== 'bigint' || p.stake <= 0n) throw new Error('stake must be a positive bigint')
    if (typeof p.threshold !== 'bigint' || p.threshold <= 0n) throw new Error('threshold must be positive')
    if (typeof p.period !== 'bigint' || p.period <= 0n) throw new Error('period must be positive')
    if (!Array.isArray(p.validatorSubset) || p.validatorSubset.length < MIN_SUBSET) {
      throw new Error(`validatorSubset must have at least ${MIN_SUBSET} members`)
    }
    const distinct = new Set(p.validatorSubset.map((a) => a.toLowerCase()))
    if (distinct.size !== p.validatorSubset.length) throw new Error('validatorSubset must be distinct')
    return { stake: p.stake, threshold: p.threshold, period: p.period, validatorSubset: p.validatorSubset }
  },

  decodeEntry: (raw) => {
    const e = raw as RaffleEntry
    return {
      ticketId: BigInt(e.ticketId),
      player: e.player,
      guess: BigInt(e.guess),
      committedAtBlock: BigInt(e.committedAtBlock),
      revealed: Boolean(e.revealed),
    }
  },

  canArm: (params, entries) => BigInt(entries.length) >= params.threshold,

  /**
   * The closest revealed guess to the draw wins; ties broken by earliest commit block then smallest
   * ticket id — identical to the contract's reveal/overwrite comparison, so the off-chain winner
   * equals the on-chain payout. Returns null on a no-contest (no revealed entries).
   */
  settle: (_params, entries, seed) => {
    const draw = raffleDraw(seed)
    const revealed = entries.filter((e) => e.revealed)
    if (revealed.length === 0) return null
    let best = revealed[0]!
    let bestDistance = distance(best.guess, draw)
    for (const e of revealed.slice(1)) {
      const d = distance(e.guess, draw)
      const closer =
        d < bestDistance ||
        (d === bestDistance &&
          (e.committedAtBlock < best.committedAtBlock ||
            (e.committedAtBlock === best.committedAtBlock && e.ticketId < best.ticketId)))
      if (closer) {
        best = e
        bestDistance = d
      }
    }
    return { ticketId: best.ticketId, player: best.player, guess: best.guess, distance: bestDistance }
  },

  presets: [],
}

const STAKE_LADDER = [viem.parseEther('0.1'), viem.parseEther('1'), viem.parseEther('10')] as const
export const CANONICAL_THRESHOLD = 3n
export const CANONICAL_PERIOD = 30n // blocks a round fills before it may arm — long enough to gather entries

/**
 * The canonical presets for a chain's recommended validator subset. One threshold/period shape
 * across a stake ladder so identical tuples land in the same round (the round key is the
 * parameter tuple — fragmenting the tuple fragments the pot). Subset is deployment config.
 */
export const makePresets = (validatorSubset: viem.Hex[]): Preset<RaffleParams>[] =>
  STAKE_LADDER.map((stake) => ({
    label: `${viem.formatEther(stake)} raffle (${CANONICAL_THRESHOLD} players)`,
    params: { stake, threshold: CANONICAL_THRESHOLD, period: CANONICAL_PERIOD, validatorSubset },
  }))
