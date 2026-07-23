import { describe, it, expect } from 'vitest'
import { encodeGameState, hashGameStateAbi, encodeMove } from '../src/encoding'
import { initialFlipState, hashGameState } from '../src/rules'

describe('abi encoding', () => {
  const s0 = initialFlipState({ ante: 5n, deckIndex: 0, warPot: 0n })

  it('encodes a fresh flip state deterministically', () => {
    expect(encodeGameState(s0)).toEqual(encodeGameState(initialFlipState({ ante: 5n, deckIndex: 0, warPot: 0n })))
  })

  it('hash changes when any field changes', () => {
    const h0 = hashGameStateAbi(s0)
    expect(hashGameStateAbi({ ...s0, warPot: 1n })).not.toEqual(h0)
    expect(hashGameStateAbi({ ...s0, foldedCardHidden: true })).not.toEqual(h0)
  })

  it('rules.hashGameState IS the abi hash now', () => {
    expect(hashGameState(s0)).toEqual(hashGameStateAbi(s0))
  })

  it('encodes every move kind without throwing', () => {
    expect(encodeMove({ kind: 'DEAL_DONE' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'BET_COMMIT', by: 'A', commitment: `0x${'11'.repeat(32)}` })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: `0x${'22'.repeat(32)}` })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'CALL', by: 'B' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'FOLD', by: 'A' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'SHOWDOWN', cardA: 51, cardB: 0 })).toMatch(/^0x/)
  })

  it('null result encodes as resultSet=false (re-encode is stable)', () => {
    expect(s0.result).toBeNull()
    expect(encodeGameState(s0)).toEqual(encodeGameState({ ...s0, result: null }))
  })

  it('encodes fresh state to expected consensus bytes (golden vector)', () => {
    expect(encodeGameState(s0)).toEqual('0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')
  })
})
