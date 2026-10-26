import { describe, it, expect, vi } from 'vitest'

const calls: string[] = []
vi.mock('@msgboard/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@msgboard/sdk')>()
  class FakeClient {
    async status() { return { enabled: true, workMultiplier: '1', workDivisor: '1' } }
    async content() { calls.push('content'); return {} }
    async contentAll() { calls.push('contentAll'); return { '0xaa': [] } }
  }
  return { ...actual, MsgBoardClient: FakeClient }
})
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, createPublicClient: () => ({ getBlockNumber: async () => 1n, getBalance: async () => 0n }) }
})

describe('loadContent', () => {
  it('reads the board with contentAll, never with one unpaged content() call', async () => {
    const { useChainStore } = await import('../src/stores/chain')
    await useChainStore.getState().loadContent()
    expect(calls).toContain('contentAll')
    expect(calls).not.toContain('content')
    expect(useChainStore.getState().content).toEqual({ '0xaa': [] })
  })
})
