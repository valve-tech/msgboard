import * as viem from 'viem'
import { coinFlipTablesAbi } from '@msgboard/games-core'

/** The subset of a `createTable` receipt that `parseTableIdFromReceipt` needs (matches
 *  viem.TransactionReceipt['logs'], which is a mutable array). */
export type CreateReceiptLike = { logs: viem.Log[] }

/**
 * Pull the new table's id out of a `createTable` receipt. `TableCreated` indexes `tableId` as its
 * first topic (alongside `operator`); `parseEventLogs` decodes it (and the non-indexed params) via
 * the CoinFlipTables ABI. Returns undefined when the receipt carries no `TableCreated` log — a
 * malformed/foreign receipt the caller should treat as a failure rather than guess at an id.
 */
export const parseTableIdFromReceipt = (receipt: CreateReceiptLike): viem.Hex | undefined => {
  const [created] = viem.parseEventLogs({ abi: coinFlipTablesAbi, eventName: 'TableCreated', logs: receipt.logs })
  const args = created?.args as { tableId?: viem.Hex } | undefined
  return args?.tableId
}
