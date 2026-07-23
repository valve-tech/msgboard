import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type SessionState, TEST_DOMAIN, SESSION_STATE_TYPES,
  hashSessionState, signSessionState, verifySessionStateSig,
} from '../src/sessionState'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)

const base: SessionState = {
  tableId: `0x${'ab'.repeat(32)}`,
  nonce: 0n,
  balancePlayer: 1000n,
  balanceHouse: 1000n,
  settlementMode: 0,
  gameId: 1,
  gameStateHash: `0x${'00'.repeat(32)}`,
  rngCommit: `0x${'cd'.repeat(32)}`,
}

describe('SessionState EIP-712', () => {
  it('hash is deterministic', () => {
    expect(hashSessionState(TEST_DOMAIN, base)).toBe(hashSessionState(TEST_DOMAIN, base))
  })

  it('hash is sensitive to every field', () => {
    const h = hashSessionState(TEST_DOMAIN, base)
    expect(hashSessionState(TEST_DOMAIN, { ...base, nonce: 1n })).not.toBe(h)
    expect(hashSessionState(TEST_DOMAIN, { ...base, balancePlayer: 999n })).not.toBe(h)
    expect(hashSessionState(TEST_DOMAIN, { ...base, settlementMode: 1 })).not.toBe(h)
    expect(hashSessionState(TEST_DOMAIN, { ...base, gameId: 2 })).not.toBe(h)
  })

  it('round-trips a signature and rejects the wrong signer', async () => {
    const sig = await signSessionState(player, TEST_DOMAIN, base)
    expect(await verifySessionStateSig(player.address, TEST_DOMAIN, base, sig)).toBe(true)
    expect(await verifySessionStateSig(house.address, TEST_DOMAIN, base, sig)).toBe(false)
  })

  it('exposes the canonical type tuple in order', () => {
    expect(SESSION_STATE_TYPES.SessionState.map((f) => f.name)).toEqual([
      'tableId', 'nonce', 'balancePlayer', 'balanceHouse',
      'settlementMode', 'gameId', 'gameStateHash', 'rngCommit',
    ])
  })
})
