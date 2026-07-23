import { describe, it, expect, beforeEach } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { Channel } from '../src/channel'
import { TEST_DOMAIN, type ChannelState } from '../src/stateSig'

const A = privateKeyToAccount(generatePrivateKey())
const B = privateKeyToAccount(generatePrivateKey())
const ESCROW = 200n
const base: ChannelState = {
  tableId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  nonce: 0n, balanceA: 100n, balanceB: 100n, pot: 0n,
  deckCommitment: ('0x' + '00'.repeat(32)) as `0x${string}`,
  phase: 0, gameStateHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
}
const next = (s: ChannelState, patch: Partial<ChannelState>): ChannelState =>
  ({ ...s, ...patch, nonce: s.nonce + 1n })

let chA: Channel, chB: Channel
beforeEach(async () => {
  chA = new Channel({ domain: TEST_DOMAIN, tableId: base.tableId, me: A, peer: B.address, role: 'A', escrow: ESCROW })
  chB = new Channel({ domain: TEST_DOMAIN, tableId: base.tableId, me: B, peer: A.address, role: 'B', escrow: ESCROW })
  const genesis = await chA.propose(base)
  const counter = await chB.accept(genesis)
  await chA.finalize(counter)
})

describe('channel co-signing', () => {
  it('advances on propose → accept → finalize', async () => {
    const p = await chA.propose(next(chA.latest!.state, { pot: 2n, balanceA: 99n, balanceB: 99n }))
    const c = await chB.accept(p)
    await chA.finalize(c)
    expect(chA.latest!.state.nonce).toBe(1n)
    expect(chB.latest!.state.nonce).toBe(1n)
    expect(chA.latest!.sigA && chA.latest!.sigB).toBeTruthy()
  })
  it('rejects non-incrementing nonce', async () => {
    const p = await chA.propose(next(chA.latest!.state, { pot: 2n, balanceA: 99n, balanceB: 99n }))
    const c = await chB.accept(p); await chA.finalize(c)
    await expect(chB.accept(p)).rejects.toThrow(/nonce/)
  })
  it('rejects conservation violation', async () => {
    await expect(
      chA.propose(next(chA.latest!.state, { balanceA: 150n })) // A+B+pot > escrow
    ).rejects.toThrow(/conservation/)
  })
  it('rejects bad proposer signature', async () => {
    const p = await chA.propose(next(chA.latest!.state, { pot: 2n, balanceA: 99n, balanceB: 99n }))
    // corrupt a byte of r (never the trailing v byte: v=27→0 can still
    // recover the same signer when yParity is 0)
    const c = p.sigA![10] === 'a' ? 'b' : 'a'
    p.sigA = (p.sigA!.slice(0, 10) + c + p.sigA!.slice(11)) as `0x${string}`
    await expect(chB.accept(p)).rejects.toThrow(/signature/)
  })
  it('rejects when game legality callback vetoes', async () => {
    chB.setLegality(() => 'illegal: phase skip')
    const p = await chA.propose(next(chA.latest!.state, { phase: 9 }))
    await expect(chB.accept(p)).rejects.toThrow(/illegal: phase skip/)
  })
  it('negative balances are impossible', async () => {
    await expect(
      chA.propose(next(chA.latest!.state, { balanceA: -1n, pot: 101n }))
    ).rejects.toThrow(/negative/)
  })
  it('finalize rejects a countersigned state that differs from the proposal', async () => {
    const p = await chA.propose(next(chA.latest!.state, { pot: 2n, balanceA: 99n, balanceB: 99n }))
    const tampered = { ...p.state, balanceA: 98n, balanceB: 100n }
    await expect(chA.finalize({ state: tampered, sigA: p.sigA })).rejects.toThrow(/does not match pending|signature/)
  })
  it('rejects a proposal for the wrong table', async () => {
    await expect(
      chA.propose({ ...next(chA.latest!.state, {}), tableId: ('0x' + 'ff'.repeat(32)) as `0x${string}` })
    ).rejects.toThrow(/tableId/)
  })
  it('rejects uint64/uint8 overflow', async () => {
    await expect(chA.propose({ ...chA.latest!.state, nonce: (1n << 64n) })).rejects.toThrow(/uint64/)
    await expect(chA.propose(next(chA.latest!.state, { phase: 256 }))).rejects.toThrow(/uint8/)
  })
})

describe('channel applyTopUp', () => {
  it('applyTopUp raises escrow and conservation tracks it', async () => {
    // Both channels mirror the on-chain top-up
    chA.applyTopUp(10n)
    chB.applyTopUp(10n)
    // Propose a state whose balances sum to ESCROW + 10n (balanceA gains the top-up)
    const topped = next(chA.latest!.state, { balanceA: 110n, balanceB: 100n, pot: 0n })
    const p = await chA.propose(topped)
    const c = await chB.accept(p)
    await chA.finalize(c)
    expect(chA.latest!.state.balanceA).toBe(110n)
  })

  it('cumulative applyTopUp: two top-ups are additive, not replacement', async () => {
    // Both channels receive two separate top-up events
    chA.applyTopUp(10n)
    chA.applyTopUp(20n)
    chB.applyTopUp(10n)
    chB.applyTopUp(20n)
    // State must sum to ESCROW + 30n (200n + 30n = 230n)
    const topped = next(chA.latest!.state, { balanceA: 130n, balanceB: 100n, pot: 0n })
    const p = await chA.propose(topped)
    const c = await chB.accept(p)
    await chA.finalize(c)
    expect(chA.latest!.state.balanceA).toBe(130n)
  })

  it('channel WITHOUT applyTopUp rejects state that assumes a top-up', async () => {
    // Only chA gets the top-up; chB does not — so chB must reject
    chA.applyTopUp(10n)
    const topped = next(chA.latest!.state, { balanceA: 110n, balanceB: 100n, pot: 0n })
    const p = await chA.propose(topped)
    // chB still has ESCROW=200n, so A+B+pot=210n != 200n → conservation error
    await expect(chB.accept(p)).rejects.toThrow(/conservation/)
  })

  it('applyTopUp(0n) throws', () => {
    expect(() => chA.applyTopUp(0n)).toThrow()
  })

  it('applyTopUp with negative amount throws', () => {
    expect(() => chA.applyTopUp(-1n)).toThrow()
  })
})
