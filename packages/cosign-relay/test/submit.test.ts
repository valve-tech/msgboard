import { afterEach, describe, expect, it } from 'vitest'
import { enabledChains, sponsorAddress, sponsorInfo } from '../src/submit.js'

// A well-known test key (Anvil/Hardhat default account #0) — its address is public knowledge, so
// asserting on it never risks leaking anything real. Never a live-funded relay key.
const KNOWN_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const KNOWN_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

afterEach(() => {
  delete process.env.RELAY_KEY_943
  delete process.env.RELAY_KEY_369
})

describe('sponsorAddress', () => {
  it('is undefined when no key is configured for the chain', () => {
    expect(sponsorAddress(943)).toBeUndefined()
  })

  it('derives the known address from a known key', () => {
    process.env.RELAY_KEY_943 = KNOWN_KEY
    expect(sponsorAddress(943)).toBe(KNOWN_ADDRESS)
  })
})

describe('sponsorInfo', () => {
  it('is empty when no chains are enabled (never touches an RPC)', async () => {
    expect(enabledChains()).toEqual([])
    expect(await sponsorInfo()).toEqual([])
  })
})
