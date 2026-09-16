import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { coinFlipTablesAbi } from '@msgboard/games-core'
import { parseTableIdFromReceipt } from './tableCreate'

const tableId = viem.keccak256(viem.toHex('table-1'))
const operator = '0x111111111111111111111111111111111111111a' as viem.Hex

/** Build a real, ABI-encoded `TableCreated` log — parseEventLogs decodes topics+data, so a fake
 *  log has to be genuinely encoded rather than a plain `args` object like the reducer tests use. */
const tableCreatedLog = (): viem.Log => {
  // coinFlipTablesAbi is typed as the widened `viem.Abi` (its artifact import loses the literal
  // shape), so encodeEventTopics can't narrow its return to a plain Hex[] — cast past that.
  const topics = viem.encodeEventTopics({
    abi: coinFlipTablesAbi,
    eventName: 'TableCreated',
    args: { tableId, operator },
  }) as viem.Log['topics']
  return {
    address: '0x222222222222222222222222222222222222222b' as viem.Hex,
    topics,
    data: viem.encodeAbiParameters(
      [{ type: 'uint16' }, { type: 'uint256' }, { type: 'uint256' }],
      [180, 10n ** 18n, 100n * 10n ** 18n],
    ),
    blockNumber: 5n,
    blockHash: `0x${'bb'.repeat(32)}` as viem.Hex,
    transactionHash: `0x${'aa'.repeat(32)}` as viem.Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  }
}

describe('parseTableIdFromReceipt', () => {
  it('decodes the tableId out of a TableCreated log', () => {
    expect(parseTableIdFromReceipt({ logs: [tableCreatedLog()] })).toBe(tableId)
  })

  it('returns undefined when the receipt has no TableCreated log', () => {
    expect(parseTableIdFromReceipt({ logs: [] })).toBeUndefined()
  })

  it('ignores unrelated logs in the same receipt', () => {
    const foreign: viem.Log = { ...tableCreatedLog(), topics: ['0xdeadbeef' as viem.Hex] }
    expect(parseTableIdFromReceipt({ logs: [foreign, tableCreatedLog()] })).toBe(tableId)
  })
})
