import { describe, it, expect } from 'vitest'
import { archetypeFor } from './archetype'

describe('archetypeFor', () => {
  it('maps card tables to felt', () => {
    for (const g of ['blackjack', 'baccarat', 'dragon-tiger', 'andar-bahar', 'three-card', 'pai-gow', 'craps', 'monte', 'hilo'])
      expect(archetypeFor(g)).toBe('felt')
  })
  it('maps the dice family to strip', () => {
    for (const g of ['dice', 'dicex2', 'limbo']) expect(archetypeFor(g)).toBe('strip')
  })
  it('maps crash to canvas', () => expect(archetypeFor('crash')).toBe('canvas'))
  it('maps roulette to wheel', () => {
    for (const g of ['roulette', 'wheel']) expect(archetypeFor(g)).toBe('wheel')
  })
  it('maps reveal games to grid', () => {
    for (const g of ['mines', 'towers', 'keno', 'plinko', 'pachinko', 'cascade', 'sudoku', 'wordle'])
      expect(archetypeFor(g)).toBe('grid')
  })
  it('defaults unknown ids to grid', () => expect(archetypeFor('nope')).toBe('grid'))
})
