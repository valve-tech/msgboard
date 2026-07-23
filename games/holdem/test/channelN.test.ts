import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { Hex } from 'viem'
import { ChannelN } from '../src/channelN'
import { TEST_DOMAIN_N, totalLocked, type ChannelStateN, type SidePot } from '../src/stateSigN'

const TABLE_ID = ('0x' + 'ab'.repeat(32)) as Hex
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex

function mkSeats(n: number) {
  return Array.from({ length: n }, () => privateKeyToAccount(generatePrivateKey()))
}

function genesis(n: number, escrowEach: bigint): ChannelStateN {
  return {
    tableId: TABLE_ID,
    nonce: 0n,
    balances: Array.from({ length: n }, () => escrowEach),
    pot: 0n,
    sidePots: [],
    rakeAccrued: 0n,
    deckCommitment: ZERO32,
    phase: 0,
    gameStateHash: ZERO32,
  }
}

function next(s: ChannelStateN, patch: Partial<ChannelStateN>): ChannelStateN {
  return { ...s, ...patch, nonce: s.nonce + 1n }
}

/// Build N channels (one per seat) and drive a full N-of-N co-sign of `state`,
/// returning the fully-signed state from the proposer's channel.
async function coSignAll(
  channels: ChannelN[], proposer: number, state: ChannelStateN,
) {
  let partial = await channels[proposer]!.propose(state)
  for (let i = 0; i < channels.length; i++) {
    if (i === proposer) continue
    partial = await channels[i]!.countersign(partial)
  }
  await channels[proposer]!.finalize(partial)
  // fan-out: every non-proposer seat adopts the completed N-of-N state
  for (let i = 0; i < channels.length; i++) {
    if (i === proposer) continue
    await channels[i]!.adopt(partial)
  }
  return partial
}

function makeChannels(seats: ReturnType<typeof mkSeats>, escrow: bigint): ChannelN[] {
  const seatKeys = seats.map((s) => s.address)
  return seats.map((s, seat) => new ChannelN({
    domain: TEST_DOMAIN_N, tableId: TABLE_ID, me: s, seat, seatKeys, escrow,
  }))
}

describe('ChannelN N-of-N co-signing', () => {
  it('genesis: N=2 fully co-signs at nonce 0 and conserves', async () => {
    const seats = mkSeats(2)
    const escrow = 200n
    const channels = makeChannels(seats, escrow)
    const g = genesis(2, 100n)
    const full = await coSignAll(channels, 0, g)
    expect(channels[0]!.fullySigned(full)).toBe(true)
    expect(channels[0]!.latest!.state.nonce).toBe(0n)
    expect(channels[1]!.latest!.state.nonce).toBe(0n)
    expect(totalLocked(full.state)).toBe(escrow)
  })

  it('genesis: N=3 fully co-signs (3 sigs) and conserves', async () => {
    const seats = mkSeats(3)
    const escrow = 300n
    const channels = makeChannels(seats, escrow)
    const full = await coSignAll(channels, 0, genesis(3, 100n))
    expect(full.sigs.filter((x) => x !== undefined).length).toBe(3)
    expect(channels[2]!.latest!.state.nonce).toBe(0n)
  })

  it('advances on monotone nonce with pot moved from balances', async () => {
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    // seats post a pot: each puts 10 into pot
    const s1 = next(channels[0]!.latest!.state, {
      balances: [90n, 90n, 90n], pot: 30n,
    })
    await coSignAll(channels, 1, s1)
    expect(channels[0]!.latest!.state.nonce).toBe(1n)
    expect(channels[0]!.latest!.state.pot).toBe(30n)
  })

  it('rejects non-incrementing nonce', async () => {
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    // latest nonce is now 0; a state re-proposing nonce 0 (or skipping to 2) must fail
    const stale = { ...genesis(3, 100n), nonce: 0n } // must be 1 now
    await expect(channels[0]!.propose(stale)).rejects.toThrow(/nonce/)
    const skip = { ...channels[0]!.latest!.state, nonce: 5n } // jumps past 1
    await expect(channels[0]!.propose(skip)).rejects.toThrow(/nonce/)
  })

  it('rejects conservation violation including side-pots + rake', async () => {
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    // Σbalances + pot + ΣsidePots + rake must equal 300; here it sums to 310
    const bad = next(channels[0]!.latest!.state, {
      balances: [100n, 100n, 50n],
      pot: 20n,
      sidePots: [{ amount: 30n, eligibleMask: 0b011n }] as SidePot[],
      rakeAccrued: 10n,
    })
    await expect(channels[0]!.propose(bad)).rejects.toThrow(/conservation/)
  })

  it('accepts a conserving state WITH side-pots + rake', async () => {
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    // 80+80+50 + pot20 + sidePot40 + rake30 = 300
    const ok = next(channels[0]!.latest!.state, {
      balances: [80n, 80n, 50n],
      pot: 20n,
      sidePots: [{ amount: 40n, eligibleMask: 0b101n }] as SidePot[],
      rakeAccrued: 30n,
    })
    const full = await coSignAll(channels, 0, ok)
    expect(totalLocked(full.state)).toBe(300n)
    expect(channels[0]!.latest!.state.sidePots[0]!.amount).toBe(40n)
  })

  it('rejects a forged signature for any seat', async () => {
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    const p = await channels[0]!.propose(next(channels[0]!.latest!.state, { pot: 0n }))
    // corrupt seat 0's signature byte (not the trailing v)
    const sig = p.sigs[0]!
    const c = sig[10] === 'a' ? 'b' : 'a'
    p.sigs[0] = (sig.slice(0, 10) + c + sig.slice(11)) as Hex
    await expect(channels[1]!.countersign(p)).rejects.toThrow(/signature/)
  })

  it('rejects wrong balances vector length', async () => {
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    const bad = next(channels[0]!.latest!.state, { balances: [150n, 150n] }) // length 2 != 3
    await expect(channels[0]!.propose(bad)).rejects.toThrow(/balances length/)
  })

  it('legality veto rejects a state', async () => {
    const seats = mkSeats(2)
    const channels = makeChannels(seats, 200n)
    await coSignAll(channels, 0, genesis(2, 100n))
    channels[1]!.setLegality(() => 'illegal: phase skip')
    const p = await channels[0]!.propose(next(channels[0]!.latest!.state, { phase: 9 }))
    await expect(channels[1]!.countersign(p)).rejects.toThrow(/illegal: phase skip/)
  })

  it('forced-fold transition: a seat forfeits in-pot stake, conservation holds', async () => {
    // models the off-chain mirror of resolveTimeout: seat 2 stalls; its committed
    // chips stay in the pot to be awarded to the others. Balances + pot still == escrow.
    const seats = mkSeats(3)
    const channels = makeChannels(seats, 300n)
    await coSignAll(channels, 0, genesis(3, 100n))
    // all three commit 20 to pot (balances 80/80/80, pot 60)
    const betting = next(channels[0]!.latest!.state, { balances: [80n, 80n, 80n], pot: 60n })
    await coSignAll(channels, 0, betting)
    // seat 2 force-folds: its 20 stays in pot, awarded; seats 0/1 split the 60 pot.
    const settled = next(channels[0]!.latest!.state, {
      balances: [110n, 110n, 80n], pot: 0n, phase: 11,
    })
    const full = await coSignAll(channels, 0, settled)
    expect(totalLocked(full.state)).toBe(300n)
    expect(full.state.balances[2]).toBe(80n) // staller kept its stack, lost its 20 in pot
  })
})
