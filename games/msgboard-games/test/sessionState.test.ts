import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type SessionState, type SessionClose, TEST_DOMAIN, SESSION_STATE_TYPES, SESSION_CLOSE_TYPES,
  hashSessionState, signSessionState, verifySessionStateSig,
  hashSessionClose, signClose, verifyCloseSig, closeFromState, closeToBody, closeFromBody,
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

describe('SessionClose EIP-712 (mutual close)', () => {
  const close: SessionClose = {
    tableId: `0x${'ab'.repeat(32)}`,
    nonce: 5n,
    balancePlayer: 260n,
    balanceHouse: 140n,
    gameId: 1,
  }

  it('exposes the canonical SessionClose type string in order (mirrors SessionCloseLib.TYPEHASH)', () => {
    expect(SESSION_CLOSE_TYPES.SessionClose.map((f) => f.name)).toEqual([
      'tableId', 'nonce', 'balancePlayer', 'balanceHouse', 'gameId',
    ])
    expect(SESSION_CLOSE_TYPES.SessionClose.map((f) => f.type)).toEqual([
      'bytes32', 'uint64', 'uint256', 'uint256', 'uint8',
    ])
  })

  it('hash is deterministic and sensitive to every field', () => {
    const h = hashSessionClose(TEST_DOMAIN, close)
    expect(hashSessionClose(TEST_DOMAIN, close)).toBe(h)
    expect(hashSessionClose(TEST_DOMAIN, { ...close, nonce: 6n })).not.toBe(h)
    expect(hashSessionClose(TEST_DOMAIN, { ...close, balancePlayer: 261n })).not.toBe(h)
    expect(hashSessionClose(TEST_DOMAIN, { ...close, balanceHouse: 139n })).not.toBe(h)
    expect(hashSessionClose(TEST_DOMAIN, { ...close, gameId: 2 })).not.toBe(h)
  })

  it('the close digest is DISTINCT from a same-field SessionState digest (type separation)', () => {
    // A running state co-signed mid-play must never be replayable as a close: different EIP-712 type.
    const state: SessionState = {
      tableId: close.tableId, nonce: close.nonce,
      balancePlayer: close.balancePlayer, balanceHouse: close.balanceHouse,
      settlementMode: 1, gameId: close.gameId,
      gameStateHash: `0x${'00'.repeat(32)}`, rngCommit: `0x${'00'.repeat(32)}`,
    }
    expect(hashSessionClose(TEST_DOMAIN, close)).not.toBe(hashSessionState(TEST_DOMAIN, state))
  })

  it('round-trips a close signature and rejects the wrong signer', async () => {
    const sig = await signClose(player, TEST_DOMAIN, close)
    expect(await verifyCloseSig(player.address, TEST_DOMAIN, close, sig)).toBe(true)
    expect(await verifyCloseSig(house.address, TEST_DOMAIN, close, sig)).toBe(false)
  })

  it('a running-state signature does NOT verify as a close signature (no cross-replay)', async () => {
    const state: SessionState = {
      tableId: close.tableId, nonce: close.nonce,
      balancePlayer: close.balancePlayer, balanceHouse: close.balanceHouse,
      settlementMode: 1, gameId: close.gameId,
      gameStateHash: `0x${'00'.repeat(32)}`, rngCommit: `0x${'00'.repeat(32)}`,
    }
    const stateSig = await signSessionState(player, TEST_DOMAIN, state)
    expect(await verifyCloseSig(player.address, TEST_DOMAIN, close, stateSig)).toBe(false)
  })

  it('closeFromState projects the five consensus fields', () => {
    const state: SessionState = {
      tableId: close.tableId, nonce: 7n, balancePlayer: 300n, balanceHouse: 100n,
      settlementMode: 1, gameId: 2, gameStateHash: `0x${'11'.repeat(32)}`, rngCommit: `0x${'22'.repeat(32)}`,
    }
    expect(closeFromState(state)).toEqual({
      tableId: close.tableId, nonce: 7n, balancePlayer: 300n, balanceHouse: 100n, gameId: 2,
    })
  })

  it('closeToBody/closeFromBody round-trip exactly (transcript JSON carrier)', () => {
    expect(closeFromBody(closeToBody(close))).toEqual(close)
  })
})
