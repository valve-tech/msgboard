import { describe, it, expect } from 'vitest'
import { verifyRound } from './tablesVerify'

const base = {
  roundId: '0xrr' as any, tableId: '0xtt' as any, player: '0x00000000000000000000000000000000000000a1' as any,
}

describe('verifyRound', () => {
  it('accepts a consistent win (even seed, side HEADS)', () => {
    const opened = { ...base, side: 0, stake: 1_000000000000000000n, payout: 1_960000000000000000n, subsetHash: '0xss' as any, key: '0xkk' as any, openedAtBlock: 10n }
    const settled = { ...base, won: true, payout: 1_960000000000000000n, seed: ('0x' + '00'.repeat(31) + '02') as any, settledAtBlock: 12n } // seed&1==0 -> HEADS wins
    expect(verifyRound(opened as any, settled as any).ok).to.equal(true)
  })

  it('rejects a settle log claiming a win the seed parity contradicts', () => {
    const opened = { ...base, side: 0, stake: 1_000000000000000000n, payout: 1_960000000000000000n, subsetHash: '0xss' as any, key: '0xkk' as any, openedAtBlock: 10n }
    const settled = { ...base, won: true, payout: 1_960000000000000000n, seed: ('0x' + '00'.repeat(31) + '01') as any, settledAtBlock: 12n } // seed&1==1 -> TAILS, player had HEADS
    const res = verifyRound(opened as any, settled as any)
    expect(res.ok).to.equal(false)
    expect(res.reasons.join(' ')).to.match(/parity/i)
  })

  it('rejects a payout that does not equal the open-snapshot payout', () => {
    const opened = { ...base, side: 0, stake: 1_000000000000000000n, payout: 1_960000000000000000n, subsetHash: '0xss' as any, key: '0xkk' as any, openedAtBlock: 10n }
    const settled = { ...base, won: true, payout: 2_000000000000000000n, seed: ('0x' + '00'.repeat(31) + '02') as any, settledAtBlock: 12n }
    expect(verifyRound(opened as any, settled as any).ok).to.equal(false)
  })
})
