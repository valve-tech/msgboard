import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { verifyCoinFlip, verifyRaffle } from '../src/model/verify'

const A = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as viem.Hex
const B = '0xBbbBBbbbBbbBbbbBbBBBBBBBBbbbBbBbBbbBbbBb' as viem.Hex

describe('verifyCoinFlip', () => {
  const evenSeed = viem.padHex('0x02', { size: 32 })
  const oddSeed = viem.padHex('0x03', { size: 32 })

  it('matches when the on-chain winner equals the parity winner (case-insensitive)', () => {
    const result = verifyCoinFlip({ seed: evenSeed, heads: A, tails: B, onChainWinner: A.toLowerCase() as viem.Hex })
    expect(result).to.deep.include({ winningSide: 'heads', matches: true })
    expect(verifyCoinFlip({ seed: oddSeed, heads: A, tails: B, onChainWinner: B }).matches).to.equal(true)
  })

  it('surfaces a mismatch when fed a wrong on-chain winner', () => {
    const result = verifyCoinFlip({ seed: evenSeed, heads: A, tails: B, onChainWinner: B })
    expect(result.matches).to.equal(false)
    expect(viem.isAddressEqual(result.offChainWinner, A)).to.equal(true)
  })
})

describe('verifyRaffle', () => {
  const seed = viem.padHex('0x80', { size: 32 }) // draw 129
  const entries = [
    { ticketId: 1n, player: A, guess: 100n, committedAtBlock: 1n, revealed: true },
    { ticketId: 2n, player: B, guess: 130n, committedAtBlock: 1n, revealed: true },
  ]

  it('recomputes the draw and the winning ticket and matches the on-chain best', () => {
    const result = verifyRaffle({ seed, entries, onChainBestTicket: 2n })
    expect(result).to.deep.include({ draw: 129n, offChainTicket: 2n, matches: true })
  })

  it('surfaces a mismatch when the on-chain best ticket disagrees', () => {
    expect(verifyRaffle({ seed, entries, onChainBestTicket: 1n }).matches).to.equal(false)
  })

  it('a no-contest (nothing revealed) matches an on-chain best of zero', () => {
    const unrevealed = entries.map((e) => ({ ...e, revealed: false }))
    const result = verifyRaffle({ seed, entries: unrevealed, onChainBestTicket: 0n })
    expect(result).to.deep.include({ offChainTicket: null, matches: true })
  })
})
