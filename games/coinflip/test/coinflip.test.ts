import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { coinflip, makePresets } from '../src/index'

const params = {
  stake: viem.parseEther('1'),
  validatorSubset: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333',
  ] as viem.Hex[],
}

describe('coinflip.settle', () => {
  it('returns heads on an even seed and tails on an odd seed', () => {
    const entries = [
      { player: '0xaaa' as viem.Hex, side: 'heads' as const },
      { player: '0xbbb' as viem.Hex, side: 'tails' as const },
    ]
    expect(coinflip.settle(params, entries, viem.padHex('0x02', { size: 32 })).winner).to.equal('0xaaa')
    expect(coinflip.settle(params, entries, viem.padHex('0x03', { size: 32 })).winner).to.equal('0xbbb')
  })

  it('canArm only with one heads and one tails at equal stake', () => {
    expect(coinflip.canArm(params, [{ player: '0xaaa', side: 'heads' }])).to.equal(false)
    expect(coinflip.canArm(params, [{ player: '0xaaa', side: 'heads' }, { player: '0xbbb', side: 'tails' }])).to.equal(true)
    expect(coinflip.canArm(params, [{ player: '0xaaa', side: 'heads' }, { player: '0xbbb', side: 'heads' }])).to.equal(false)
  })

  it('parseParams rejects a subset below the minimum of three', () => {
    expect(() => coinflip.parseParams({ stake: 1n, validatorSubset: ['0x1', '0x2'] })).to.throw()
  })

  it('parseParams rejects duplicate subset members even when the casing differs', () => {
    const dupes = ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x2222222222222222222222222222222222222222']
    expect(() => coinflip.parseParams({ stake: 1n, validatorSubset: dupes })).to.throw('distinct')
  })

  it('parseParams rejects a zero, negative, or non-bigint stake', () => {
    expect(() => coinflip.parseParams({ stake: 0n, validatorSubset: params.validatorSubset })).to.throw()
    expect(() => coinflip.parseParams({ stake: -1n, validatorSubset: params.validatorSubset })).to.throw()
    expect(() => coinflip.parseParams({ stake: 1, validatorSubset: params.validatorSubset })).to.throw()
  })

  it('decodeEntry accepts both the numeric on-chain side and the string side', () => {
    expect(coinflip.decodeEntry({ player: '0xaaa', side: 0 }).side).to.equal('heads')
    expect(coinflip.decodeEntry({ player: '0xaaa', side: 1 }).side).to.equal('tails')
    expect(coinflip.decodeEntry({ player: '0xaaa', side: 'heads' }).side).to.equal('heads')
    expect(coinflip.decodeEntry({ player: '0xaaa', side: 'tails' }).side).to.equal('tails')
  })

  it('canArm rejects overfilled and same-side pairs', () => {
    const h = { player: '0xaaa' as viem.Hex, side: 'heads' as const }
    const t = { player: '0xbbb' as viem.Hex, side: 'tails' as const }
    expect(coinflip.canArm(params, [h, t, { ...h, player: '0xccc' }])).to.equal(false)
    expect(coinflip.canArm(params, [t, { ...t, player: '0xddd' }])).to.equal(false)
    expect(coinflip.canArm(params, [])).to.equal(false)
  })

  it('settle is independent of entry order', () => {
    const h = { player: '0xaaa' as viem.Hex, side: 'heads' as const }
    const t = { player: '0xbbb' as viem.Hex, side: 'tails' as const }
    const evenSeed = viem.padHex('0x02', { size: 32 })
    expect(coinflip.settle(params, [h, t], evenSeed).winner).to.equal(coinflip.settle(params, [t, h], evenSeed).winner)
  })

  it('settle throws when no entry holds the winning side (corrupt entry set)', () => {
    const onlyTails = [{ player: '0xbbb' as viem.Hex, side: 'tails' as const }]
    expect(() => coinflip.settle(params, onlyTails, viem.padHex('0x02', { size: 32 }))).to.throw('winning side')
  })
})

describe('makePresets', () => {
  const subset = params.validatorSubset

  it('produces the canonical stake ladder bound to the given subset', () => {
    const presets = makePresets(subset)
    expect(presets.map((p) => p.params.stake)).to.deep.equal([
      viem.parseEther('0.1'),
      viem.parseEther('1'),
      viem.parseEther('10'),
    ])
    for (const p of presets) {
      expect(p.params.validatorSubset).to.deep.equal(subset)
      expect(() => coinflip.parseParams(p.params)).to.not.throw()
      expect(p.label.length).to.be.greaterThan(0)
    }
  })

  it('every preset label is distinct (the picker needs unambiguous options)', () => {
    const labels = makePresets(subset).map((p) => p.label)
    expect(new Set(labels).size).to.equal(labels.length)
  })
})
