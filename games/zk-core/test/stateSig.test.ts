import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { signState, verifyStateSig, hashState, makeDomain, TEST_DOMAIN, type ChannelState } from '../src/stateSig'

const acct = privateKeyToAccount(generatePrivateKey())
const state: ChannelState = {
  tableId: '0x' + '11'.repeat(32) as `0x${string}`,
  nonce: 7n,
  balanceA: 90n * 10n ** 18n,
  balanceB: 104n * 10n ** 18n,
  pot: 6n * 10n ** 18n,
  deckCommitment: '0x' + '22'.repeat(32) as `0x${string}`,
  phase: 3,
  gameStateHash: '0x' + '33'.repeat(32) as `0x${string}`,
}

describe('channel state signing', () => {
  it('sign → verify round-trip', async () => {
    const sig = await signState(acct, TEST_DOMAIN, state)
    expect(await verifyStateSig(acct.address, TEST_DOMAIN, state, sig)).toBe(true)
  })
  it('rejects on any field change', async () => {
    const sig = await signState(acct, TEST_DOMAIN, state)
    expect(await verifyStateSig(acct.address, TEST_DOMAIN, { ...state, nonce: 8n }, sig)).toBe(false)
    expect(await verifyStateSig(acct.address, TEST_DOMAIN, { ...state, balanceA: state.balanceA + 1n }, sig)).toBe(false)
  })
  it('rejects wrong signer and wrong domain', async () => {
    const other = privateKeyToAccount(generatePrivateKey())
    const sig = await signState(acct, TEST_DOMAIN, state)
    expect(await verifyStateSig(other.address, TEST_DOMAIN, state, sig)).toBe(false)
    expect(await verifyStateSig(acct.address, { ...TEST_DOMAIN, chainId: 369 }, state, sig)).toBe(false)
  })
  it('hashState is stable and field-sensitive', () => {
    expect(hashState(TEST_DOMAIN, state)).toBe(hashState(TEST_DOMAIN, { ...state }))
    expect(hashState(TEST_DOMAIN, state)).not.toBe(hashState(TEST_DOMAIN, { ...state, phase: 4 }))
  })
})

describe('makeDomain', () => {
  it('makeDomain builds the production domain', () => {
    const addr = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as `0x${string}`
    expect(makeDomain(369, addr)).toEqual({
      name: 'ZkTable',
      version: '1',
      chainId: 369,
      verifyingContract: addr,
    })
  })
})
