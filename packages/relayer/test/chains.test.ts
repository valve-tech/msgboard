import { describe, expect, it } from 'vitest'
import { mainnet, pulsechain, pulsechainV4, sepolia } from 'viem/chains'
import { resolveChain } from '../src/chains.js'

describe('resolveChain', () => {
  it.each([
    ['PulseChain mainnet', pulsechain.id],
    ['PulseChain testnet v4', pulsechainV4.id],
    ['Ethereum mainnet', mainnet.id],
    ['Sepolia', sepolia.id],
  ])('resolves %s', (_name, id) => {
    expect(resolveChain(id).id).toBe(id)
  })

  it('throws on a chain the board does not serve, rather than guessing one', () => {
    // A relayer pointed at an unknown chain must fail on its first tick. The
    // alternative — defaulting to some chain — indexes the wrong board silently.
    expect(() => resolveChain(999_999)).toThrow(/unsupported chainId 999999/)
  })

  it('names the supported ids in the error, so the fix is obvious', () => {
    expect(() => resolveChain(999_999)).toThrow(String(sepolia.id))
  })
})
