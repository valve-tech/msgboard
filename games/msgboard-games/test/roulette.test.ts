import { describe, it, expect } from 'vitest'
import {
  roulette, RouletteBetType, isRed, betWins, roulettePayout, rouletteWinningPocket,
  rouletteBetPayoutX100, rouletteTotalStake, validateRouletteParams, POCKETS,
  type RouletteBet, type RouletteParams,
} from '../src/games/roulette'

const S = 1_000_000n

const bet = (type: RouletteBetType, selection: number, stake: bigint): RouletteBet => ({ type, selection, stake })

describe('roulette (European single-zero)', () => {
  it('winning pocket is raw % 37 across the whole range', () => {
    expect(rouletteWinningPocket(0n)).toBe(0)
    expect(rouletteWinningPocket(36n)).toBe(36)
    expect(rouletteWinningPocket(37n)).toBe(0)
    expect(rouletteWinningPocket(123456789n)).toBe(Number(123456789n % 37n))
  })

  it('the red mask matches the canonical European red set', () => {
    const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])
    for (let p = 0; p <= 36; p++) expect(isRed(p)).toBe(RED.has(p))
    expect(isRed(0)).toBe(false) // green zero
  })

  it('true European payout multiples: straight 36x, dozen/column 3x, evens 2x', () => {
    expect(rouletteBetPayoutX100(RouletteBetType.STRAIGHT)).toBe(3600n)
    expect(rouletteBetPayoutX100(RouletteBetType.DOZEN)).toBe(300n)
    expect(rouletteBetPayoutX100(RouletteBetType.COLUMN)).toBe(300n)
    for (const t of [RouletteBetType.RED, RouletteBetType.BLACK, RouletteBetType.ODD, RouletteBetType.EVEN, RouletteBetType.HIGH, RouletteBetType.LOW]) {
      expect(rouletteBetPayoutX100(t)).toBe(200n)
    }
  })

  it('every bet type resolves correctly for every pocket, and zero loses all outside bets', () => {
    for (let p = 0; p < POCKETS; p++) {
      // straight
      for (let n = 0; n < POCKETS; n++) expect(betWins(bet(RouletteBetType.STRAIGHT, n, S), p)).toBe(p === n)
      // even-money outside bets all lose on 0
      const outside = [RouletteBetType.RED, RouletteBetType.BLACK, RouletteBetType.ODD, RouletteBetType.EVEN, RouletteBetType.HIGH, RouletteBetType.LOW]
      if (p === 0) for (const t of outside) expect(betWins(bet(t, 0, S), 0)).toBe(false)
      // red XOR black for 1..36
      if (p >= 1) expect(betWins(bet(RouletteBetType.RED, 0, S), p) !== betWins(bet(RouletteBetType.BLACK, 0, S), p)).toBe(true)
      // odd XOR even for 1..36
      if (p >= 1) expect(betWins(bet(RouletteBetType.ODD, 0, S), p) !== betWins(bet(RouletteBetType.EVEN, 0, S), p)).toBe(true)
      // high/low partition 1..36
      if (p >= 1) expect(betWins(bet(RouletteBetType.HIGH, 0, S), p) !== betWins(bet(RouletteBetType.LOW, 0, S), p)).toBe(true)
      // exactly one dozen and one column win for 1..36; none for 0
      const dozenWins = [0, 1, 2].filter((d) => betWins(bet(RouletteBetType.DOZEN, d, S), p)).length
      const colWins = [0, 1, 2].filter((c) => betWins(bet(RouletteBetType.COLUMN, c, S), p)).length
      expect(dozenWins).toBe(p === 0 ? 0 : 1)
      expect(colWins).toBe(p === 0 ? 0 : 1)
    }
  })

  it('straight-up win pays 36x and the loss pays nothing', () => {
    const params: RouletteParams = { bets: [bet(RouletteBetType.STRAIGHT, 17, S)] }
    // find a raw landing on 17 and one not on 17
    const rawHit = 17n
    const rawMiss = 18n
    expect(rouletteWinningPocket(rawHit)).toBe(17)
    const winO = roulette.settleRound(S, params, rawHit)
    expect(winO.win).toBe(true)
    expect(winO.playerDelta).toBe(35n * S) // 36x return minus the stake
    expect(winO.multiplierX100).toBe(3600n)
    const loseO = roulette.settleRound(S, params, rawMiss)
    expect(loseO.win).toBe(false)
    expect(loseO.playerDelta).toBe(-S)
    expect(loseO.multiplierX100).toBe(0n)
  })

  it('multi-bet: the round payout is the sum of the winning bets', () => {
    // 3 chips on red, 1 chip on straight-19 (which is red). On pocket 19 both win.
    const params: RouletteParams = { bets: [bet(RouletteBetType.RED, 0, 3n), bet(RouletteBetType.STRAIGHT, 19, 1n)] }
    expect(rouletteTotalStake(params)).toBe(4n)
    // pocket 19: red pays 3*2=6, straight pays 1*36=36 → 42
    expect(roulettePayout(params, 19)).toBe(42n)
    // pocket 3 (red, not 19): red pays 6, straight loses → 6
    expect(roulettePayout(params, 3)).toBe(6n)
    // pocket 4 (black): both lose → 0
    expect(roulettePayout(params, 4)).toBe(0n)
    const out = roulette.settleRound(4n, params, 19n)
    expect(out.playerDelta).toBe(42n - 4n)
  })

  it('settleRound requires the stake to equal the sum of bet stakes', () => {
    const params: RouletteParams = { bets: [bet(RouletteBetType.RED, 0, 5n)] }
    expect(() => roulette.settleRound(4n, params, 0n)).toThrow()
    expect(() => roulette.settleRound(5n, params, 1n)).not.toThrow()
  })

  it('escrow ceiling bounds every pocket and covers the worst case, for varied bet mixes', () => {
    const mixes: RouletteParams[] = [
      { bets: [bet(RouletteBetType.STRAIGHT, 0, S)] },
      { bets: [bet(RouletteBetType.RED, 0, S), bet(RouletteBetType.STRAIGHT, 7, S)] },
      { bets: [bet(RouletteBetType.DOZEN, 0, S), bet(RouletteBetType.DOZEN, 1, S), bet(RouletteBetType.COLUMN, 2, S)] },
      { bets: [bet(RouletteBetType.STRAIGHT, 5, 2n), bet(RouletteBetType.STRAIGHT, 6, 3n), bet(RouletteBetType.BLACK, 0, 5n)] },
    ]
    for (const params of mixes) {
      const total = rouletteTotalStake(params)
      const max = roulette.maxMultiplierX100(params)
      let maxPayout = 0n
      for (let p = 0; p < POCKETS; p++) {
        const payout = roulettePayout(params, p)
        if (payout > maxPayout) maxPayout = payout
        // the running settle multiplier never exceeds the ceiling
        expect(roulette.settleRound(total, params, BigInt(p)).multiplierX100).toBeLessThanOrEqual(max)
      }
      // escrow pot (total + house escrow) must cover the worst pocket
      const escrowHouse = (total * (max - 100n)) / 100n
      expect(total + escrowHouse).toBeGreaterThanOrEqual(maxPayout)
    }
  })

  it('validation rejects malformed bets', () => {
    expect(() => validateRouletteParams({ bets: [] })).toThrow()
    expect(() => validateRouletteParams({ bets: [bet(RouletteBetType.STRAIGHT, 37, S)] })).toThrow()
    expect(() => validateRouletteParams({ bets: [bet(RouletteBetType.DOZEN, 3, S)] })).toThrow()
    expect(() => validateRouletteParams({ bets: [bet(RouletteBetType.RED, 1, S)] })).toThrow() // selection must be 0
    expect(() => validateRouletteParams({ bets: [bet(RouletteBetType.STRAIGHT, 0, 0n)] })).toThrow() // zero stake
    expect(() => validateRouletteParams({ bets: [{ type: 9 as RouletteBetType, selection: 0, stake: S }] })).toThrow()
  })

  it('gameId is 25 and encodeRound is deterministic', () => {
    expect(roulette.gameId).toBe(25)
    const params: RouletteParams = { bets: [bet(RouletteBetType.RED, 0, S)] }
    expect(roulette.encodeRound(S, params, 42n)).toBe(roulette.encodeRound(S, params, 42n))
  })
})
