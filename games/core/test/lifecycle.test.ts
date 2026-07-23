import { describe, it, expect } from 'vitest'
import { toRoundState } from '../src/lifecycle'

describe('toRoundState', () => {
  it('maps raw entries through the game decoder and carries phase + seed', () => {
    const state = toRoundState(
      '0xabc',
      'settled',
      [{ side: 0, player: '0xaaa' }, { side: 1, player: '0xbbb' }],
      (raw: any) => ({ player: raw.player, side: raw.side === 0 ? 'heads' : 'tails' }),
      { seed: '0x02' },
    )
    expect(state.phase).to.equal('settled')
    expect(state.entries.map((e) => e.side)).to.deep.equal(['heads', 'tails'])
    expect(state.seed).to.equal('0x02')
  })
})
