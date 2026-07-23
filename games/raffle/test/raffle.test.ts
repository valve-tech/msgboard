import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { raffle, makePresets } from '../src/index'
import { raffleDraw } from '@msgboard/games-core'

const params = {
  stake: viem.parseEther('1'),
  threshold: 3n,
  period: 5n,
  validatorSubset: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333',
  ] as viem.Hex[],
}

const ticket = (ticketId: bigint, player: viem.Hex, guess: bigint, committedAtBlock: bigint, revealed = true) =>
  ({ ticketId, player, guess, committedAtBlock, revealed })

describe('raffle.settle', () => {
  it('picks the revealed guess closest to the draw', () => {
    const seed = viem.padHex('0x80', { size: 32 }) // draw = 1 + (128 mod 256) = 129
    const draw = raffleDraw(seed)
    expect(draw).to.equal(129n)
    const entries = [ticket(1n, '0xaaa', 10n, 1n), ticket(2n, '0xbbb', 130n, 1n), ticket(3n, '0xccc', 250n, 1n)]
    expect(raffle.settle(params, entries, seed)?.ticketId).to.equal(2n)
  })

  it('breaks an equidistant tie by earliest commit then ticket id', () => {
    const seed = viem.padHex('0x80', { size: 32 }) // draw 129
    // 128 and 130 are both distance 1; earliest committedAtBlock wins
    const entries = [ticket(5n, '0xaaa', 130n, 9n), ticket(6n, '0xbbb', 128n, 7n)]
    expect(raffle.settle(params, entries, seed)?.ticketId).to.equal(6n)
    // same block -> smallest ticket id wins
    const sameBlock = [ticket(9n, '0xaaa', 130n, 4n), ticket(8n, '0xbbb', 128n, 4n)]
    expect(raffle.settle(params, sameBlock, seed)?.ticketId).to.equal(8n)
  })

  it('ignores unrevealed entries and returns null on a no-contest', () => {
    const seed = viem.padHex('0x80', { size: 32 })
    const entries = [ticket(1n, '0xaaa', 10n, 1n, false)]
    expect(raffle.settle(params, entries, seed)).to.equal(null)
    // a closer-but-unrevealed guess must not beat a revealed one
    const mixed = [ticket(1n, '0xaaa', 129n, 1n, false), ticket(2n, '0xbbb', 1n, 1n, true)]
    expect(raffle.settle(params, mixed, seed)?.ticketId).to.equal(2n)
    expect(raffle.settle(params, [], seed)).to.equal(null)
  })

  it('handles the draw boundaries: draw 1 and draw 256 with guesses at the extremes', () => {
    const seedDraw1 = viem.padHex('0x0100', { size: 32 }) // 256 mod 256 == 0 -> draw 1
    const seedDraw256 = viem.padHex('0xff', { size: 32 }) // 255 -> draw 256
    expect(raffleDraw(seedDraw1)).to.equal(1n)
    expect(raffleDraw(seedDraw256)).to.equal(256n)
    const entries = [ticket(1n, '0xaaa', 1n, 1n), ticket(2n, '0xbbb', 256n, 1n)]
    // draw 1: guess 1 is distance 0; guess 256 is distance 255 (no wraparound in the contract)
    expect(raffle.settle(params, entries, seedDraw1)?.ticketId).to.equal(1n)
    expect(raffle.settle(params, entries, seedDraw1)?.distance).to.equal(0n)
    // draw 256: mirror image
    expect(raffle.settle(params, entries, seedDraw256)?.ticketId).to.equal(2n)
    expect(raffle.settle(params, entries, seedDraw256)?.distance).to.equal(0n)
  })

  it('settle is independent of entry order (the contract is reveal-order independent)', () => {
    const seed = viem.padHex('0x80', { size: 32 }) // draw 129
    const a = ticket(5n, '0xaaa', 130n, 9n)
    const b = ticket(6n, '0xbbb', 128n, 7n)
    const c = ticket(7n, '0xccc', 200n, 1n)
    expect(raffle.settle(params, [a, b, c], seed)?.ticketId).to.equal(raffle.settle(params, [c, b, a], seed)?.ticketId)
    expect(raffle.settle(params, [b, a, c], seed)?.ticketId).to.equal(6n)
  })

  it('canArm exactly at the threshold boundary', () => {
    const two = [ticket(1n, '0xaaa', 1n, 1n), ticket(2n, '0xbbb', 2n, 1n)]
    const three = [...two, ticket(3n, '0xccc', 3n, 1n)]
    expect(raffle.canArm(params, two)).to.equal(false) // threshold 3
    expect(raffle.canArm(params, three)).to.equal(true)
  })

  it('decodeEntry coerces loosely-typed raw records into canonical bigints and booleans', () => {
    const decoded = raffle.decodeEntry({ ticketId: 7, player: '0xaaa', guess: '42', committedAtBlock: 9, revealed: 1 })
    expect(decoded.ticketId).to.equal(7n)
    expect(decoded.guess).to.equal(42n)
    expect(decoded.committedAtBlock).to.equal(9n)
    expect(decoded.revealed).to.equal(true)
  })

  it('parseParams rejects bad thresholds, periods, stakes, and duplicate subsets', () => {
    const good = { ...params }
    expect(() => raffle.parseParams({ ...good, threshold: 0n })).to.throw()
    expect(() => raffle.parseParams({ ...good, period: 0n })).to.throw()
    expect(() => raffle.parseParams({ ...good, stake: 0n })).to.throw()
    expect(() => raffle.parseParams({ ...good, validatorSubset: good.validatorSubset.slice(0, 2) })).to.throw()
    const dupes = [good.validatorSubset[0]!, good.validatorSubset[0]!.toUpperCase().replace('0X', '0x') as viem.Hex, good.validatorSubset[1]!]
    expect(() => raffle.parseParams({ ...good, validatorSubset: dupes })).to.throw('distinct')
  })

  it('matches a brute-force reference winner over a sweep of random rounds (property check)', () => {
    // Reference: stable-sort by (distance, committedAtBlock, ticketId) and take the head —
    // an independent restatement of the contract's overwrite comparison.
    const reference = (entries: ReturnType<typeof ticket>[], draw: bigint) => {
      const revealed = entries.filter((e) => e.revealed)
      if (revealed.length === 0) return null
      const dist = (g: bigint) => (g > draw ? g - draw : draw - g)
      return [...revealed].sort((a, b) => {
        const byDistance = dist(a.guess) - dist(b.guess)
        if (byDistance !== 0n) return byDistance < 0n ? -1 : 1
        if (a.committedAtBlock !== b.committedAtBlock) return a.committedAtBlock < b.committedAtBlock ? -1 : 1
        return a.ticketId < b.ticketId ? -1 : 1
      })[0]!
    }
    // deterministic pseudo-random rounds via keccak
    const rand = (label: string, mod: bigint) => BigInt(viem.keccak256(viem.toHex(label))) % mod
    for (let round = 0; round < 100; round++) {
      const seed = viem.keccak256(viem.toHex(`round-${round}`))
      const draw = raffleDraw(seed)
      const count = Number(rand(`count-${round}`, 6n)) + 1 // 1..6 entries
      const entries = Array.from({ length: count }, (_e, i) =>
        ticket(
          BigInt(i + 1),
          `0xplayer${i}` as viem.Hex,
          1n + rand(`guess-${round}-${i}`, 256n),
          1n + rand(`block-${round}-${i}`, 3n), // small range to force block ties
          rand(`revealed-${round}-${i}`, 4n) !== 0n, // ~75% reveal rate
        ),
      )
      const expected = reference(entries, draw)
      const actual = raffle.settle(params, entries, seed)
      expect(actual?.ticketId ?? null).to.equal(expected?.ticketId ?? null)
    }
  })
})

describe('makePresets', () => {
  it('produces canonical tuples that parseParams accepts, bound to the subset', () => {
    const presets = makePresets(params.validatorSubset)
    expect(presets.length).to.be.greaterThan(0)
    for (const p of presets) {
      expect(() => raffle.parseParams(p.params)).to.not.throw()
      expect(p.params.threshold).to.equal(3n)
      expect(p.params.validatorSubset).to.deep.equal(params.validatorSubset)
      expect(p.label.length).to.be.greaterThan(0)
    }
  })

  it('spans the canonical stake ladder with distinct labels', () => {
    const presets = makePresets(params.validatorSubset)
    expect(presets.map((p) => p.params.stake)).to.deep.equal([
      viem.parseEther('0.1'),
      viem.parseEther('1'),
      viem.parseEther('10'),
    ])
    expect(new Set(presets.map((p) => p.label)).size).to.equal(presets.length)
  })
})
