import { describe, expect, it } from 'vitest'
import { encodeEventTopics, parseAbi } from 'viem'
import { bridgeAffirmationSource } from '../../src/sources/bridge-affirmation.js'
import type { RelayerContext } from '../../src/types.js'

const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
])

const recipient = '0x1111111111111111111111111111111111111111'

const fakePublicClient = (over: Record<string, unknown> = {}) =>
  ({
    chain: { id: 943 },
    getBlock: async () => ({ number: 5_000n }),
    getTransactionReceipt: async () => ({
      logs: [
        {
          address: '0xtoken',
          topics: encodeEventTopics({
            abi: transferAbi,
            eventName: 'Transfer',
            args: { from: '0x0000000000000000000000000000000000000000', to: recipient },
          }),
          data: '0x0000000000000000000000000000000000000000000000000000000000000001',
        },
      ],
    }),
    ...over,
  }) as unknown

describe('bridgeAffirmationSource', () => {
  it('returns the latest bridger recipient address', async () => {
    const publicClient = fakePublicClient({
      getLogs: async () => [{ transactionHash: '0xtx' }],
    })
    const ctx = { publicClient } as unknown as RelayerContext
    const source = bridgeAffirmationSource({ bridgeAddress: '0xbridge' })
    const items = await source.poll(ctx)
    expect(items).toEqual([recipient])
  })

  it('returns an empty array when there are no recent events', async () => {
    const publicClient = fakePublicClient({ getLogs: async () => [] })
    const ctx = { publicClient } as unknown as RelayerContext
    const source = bridgeAffirmationSource({ bridgeAddress: '0xbridge' })
    const items = await source.poll(ctx)
    expect(items).toEqual([])
  })
})
