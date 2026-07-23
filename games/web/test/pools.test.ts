import { describe, it, expect } from 'vitest'
import { poolLocationFor } from '../src/model/pools'

describe('poolLocationFor', () => {
  it('walks indexes within the first pool then rolls the offset forward a pool at a time', () => {
    const base = 2n
    const size = 64n
    expect(poolLocationFor(0n, base, size)).to.deep.equal({ offset: 2n, index: 0n })
    expect(poolLocationFor(63n, base, size)).to.deep.equal({ offset: 2n, index: 63n })
    expect(poolLocationFor(64n, base, size)).to.deep.equal({ offset: 66n, index: 0n })
    expect(poolLocationFor(129n, base, size)).to.deep.equal({ offset: 130n, index: 1n })
  })

  it('matches Random\'s cumulative-count offsets across many rotations (property sweep)', () => {
    const base = 34n
    const size = 16n
    for (let k = 0n; k < 200n; k++) {
      const { offset, index } = poolLocationFor(k, base, size)
      expect(index >= 0n && index < size).to.equal(true)
      // reconstruct k from the location — the mapping must be a bijection
      expect(((offset - base) / size) * size + index).to.equal(k)
    }
  })

  it('rejects nonsense inputs', () => {
    expect(() => poolLocationFor(0n, 0n, 0n)).to.throw()
    expect(() => poolLocationFor(-1n, 0n, 16n)).to.throw()
  })
})
