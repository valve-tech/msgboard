import { beforeEach, describe, expect, it } from 'vitest'
import { Log, useTerminalStore, selectMessageList } from '../src/stores/terminal'
import { useChainStore } from '../src/stores/chain'
import { toRPCMessage } from '@msgboard/sdk'
import type { Message } from '@msgboard/sdk'

const msg = (over: Partial<Message>): Message => ({
  version: 0,
  blockHash: '0xabc',
  category: '0x00',
  data: '0xdead',
  nonce: 1n,
  workMultiplier: 1n,
  workDivisor: 1n,
  blockNumber: 1n,
  hash: '0x00',
  ...over,
})

beforeEach(() => {
  useTerminalStore.setState({ logList: [], lastProgress: null })
  useChainStore.setState({ content: null })
})

describe('terminal store', () => {
  it('printToTerminal appends logs', () => {
    useTerminalStore.getState().printToTerminal(new Log('hello'))
    useTerminalStore.getState().printToTerminal(new Log('world'))
    const list = useTerminalStore.getState().logList
    expect(list.map((l) => l.toString())).toEqual(['hello', 'world'])
  })

  it('updateProgress sets lastProgress', () => {
    const stats = { iterations: 1n, difficulty: 1n, duration: 2, isValid: false } as never
    useTerminalStore.getState().updateProgress(stats)
    expect(useTerminalStore.getState().lastProgress).toBe(stats)
  })

  it('clearLogs empties the list', () => {
    useTerminalStore.getState().printToTerminal(new Log('x'))
    useTerminalStore.getState().clearLogs()
    expect(useTerminalStore.getState().logList).toEqual([])
  })
})

describe('messageList selector', () => {
  it('sorts by category then hash, reading chain content', () => {
    // raw RPC content, two categories out of order
    const content = {
      '0xcatB': [toRPCMessage(msg({ category: '0xcatB', hash: '0x02' }))],
      '0xcatA': [
        toRPCMessage(msg({ category: '0xcatA', hash: '0x09' })),
        toRPCMessage(msg({ category: '0xcatA', hash: '0x01' })),
      ],
    }
    useChainStore.setState({ content: content as never })
    const list = selectMessageList()
    expect(list.map((m) => [m.category, m.hash])).toEqual([
      ['0xcatA', '0x01'],
      ['0xcatA', '0x09'],
      ['0xcatB', '0x02'],
    ])
  })
})
