import { describe, it, expect } from 'vitest'
import { decodeAbiParameters } from 'viem'
import { coinflip, coinFlipSide, type CoinFlipParams } from '../src/games/coinflip'
import { encodeGameParams } from '../src/games/paramsCodec'

const STAKE = 1_000_000n

describe('coinflip (fair 50/50, 2x, no house edge)', () => {
  it('maps parity to a side: even -> heads, odd -> tails', () => {
    expect(coinFlipSide(0n)).toBe('heads')
    expect(coinFlipSide(2n)).toBe('heads')
    expect(coinFlipSide(1n)).toBe('tails')
    expect(coinFlipSide(3n)).toBe('tails')
    // a large even/odd raw still keys off the low bit only
    expect(coinFlipSide(123456789012345678901234567890n)).toBe('heads') // even
    expect(coinFlipSide(123456789012345678901234567891n)).toBe('tails') // odd
  })

  it('wins (2x, +stake) when the side matches the pick', () => {
    // even raw -> heads
    const headsWin = coinflip.settleRound(STAKE, { pick: 'heads' }, 0n)
    expect(headsWin.win).toBe(true)
    expect(headsWin.playerDelta).toBe(STAKE)
    expect(headsWin.multiplierX100).toBe(200n)

    // odd raw -> tails
    const tailsWin = coinflip.settleRound(STAKE, { pick: 'tails' }, 1n)
    expect(tailsWin.win).toBe(true)
    expect(tailsWin.playerDelta).toBe(STAKE)
    expect(tailsWin.multiplierX100).toBe(200n)
  })

  it('loses (-stake, 0x) when the side does not match the pick', () => {
    // even raw -> heads, but picked tails
    const tailsLose = coinflip.settleRound(STAKE, { pick: 'tails' }, 0n)
    expect(tailsLose.win).toBe(false)
    expect(tailsLose.playerDelta).toBe(-STAKE)
    expect(tailsLose.multiplierX100).toBe(0n)

    // odd raw -> tails, but picked heads
    const headsLose = coinflip.settleRound(STAKE, { pick: 'heads' }, 1n)
    expect(headsLose.win).toBe(false)
    expect(headsLose.playerDelta).toBe(-STAKE)
    expect(headsLose.multiplierX100).toBe(0n)
  })

  it('pays exactly 2x with no house edge', () => {
    expect(coinflip.maxMultiplierX100({ pick: 'heads' })).toBe(200n)
    expect(coinflip.maxMultiplierX100({ pick: 'tails' })).toBe(200n)
  })

  it('encodeRound abi-encodes (uint8 gameId, uint256 stake, uint8 pick, uint256 raw) and round-trips', () => {
    for (const [pick, pickCode] of [['heads', 0], ['tails', 1]] as const) {
      const raw = 42n
      const encoded = coinflip.encodeRound(STAKE, { pick } as CoinFlipParams, raw)
      const [gameId, stake, decodedPick, decodedRaw] = decodeAbiParameters(
        [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
        encoded,
      )
      expect(gameId).toBe(5) // uint8 decodes to a JS number
      expect(stake).toBe(STAKE)
      expect(decodedPick).toBe(pickCode) // uint8 -> number
      expect(decodedRaw).toBe(raw)
    }
  })

  it('rejects an unknown pick', () => {
    expect(() => coinflip.settleRound(STAKE, { pick: 'edge' as unknown as 'heads' }, 0n)).toThrow()
  })
})

describe('coinflip paramsCodec (heads/tails <-> uint8)', () => {
  it('routes gameId 5 to (uint256) pick {heads:0,tails:1} and round-trips', () => {
    for (const [pick, code] of [['heads', 0n], ['tails', 1n]] as const) {
      const blob = encodeGameParams(coinflip.gameId, { pick })
      const [decoded] = decodeAbiParameters([{ type: 'uint256' }], blob)
      expect(decoded).toBe(code)
    }
  })

  it('rejects an unknown pick', () => {
    expect(() => encodeGameParams(coinflip.gameId, { pick: 'edge' })).toThrow()
  })
})

describe('coinflip escrow ceiling (funds-safety)', () => {
  it('multiplierX100 <= maxMultiplierX100 for both parities and every pick', () => {
    for (const pick of ['heads', 'tails'] as const) {
      const max = coinflip.maxMultiplierX100({ pick })
      expect(max).toBe(200n)
      // exhaustive over the only thing that matters — parity of raw — plus large raws.
      for (const raw of [0n, 1n, 2n, 3n, 10n, 11n, (1n << 255n), (1n << 255n) + 1n, 123456789012345678901234567890n, 123456789012345678901234567891n]) {
        expect(coinflip.settleRound(STAKE, { pick }, raw).multiplierX100).toBeLessThanOrEqual(max)
      }
    }
  })
})
