import { useCallback, useEffect, useRef, useState } from 'react'
import * as viem from 'viem'
import { coinFlipTablesAbi } from '@msgboard/games-core'
import type { TableEvent } from '../lib/tablesIndex'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'

const POLL_MS = 12_000
// Chunk a getLogs scan so a full-history range never exceeds the RPC's per-request range/response
// limit (see useChainData.ts — same valve RPC, same "Request exceeds defined limit" ceiling).
const MAX_RANGE = 10_000n

export type TableEventsState = {
  events: TableEvent[]
  head: bigint
  error?: string
  refresh: () => void
}

/** The subset of a decoded log's fields decodeTableLog needs (matches viem's getContractEvents row). */
type TableLog = {
  eventName?: string
  // viem's ABI-union Log type widens `args` to `Record<string, unknown> | readonly unknown[]` (the
  // array form is the positional decode of an unnamed-parameter event, which none of ours are).
  args?: Record<string, unknown> | readonly unknown[]
  blockNumber?: bigint | null
}

/**
 * Decode one CoinFlipTables log into the flat `{ type, tableId, blockNumber, ...args }` shape
 * `reduceTables` (lib/tablesIndex.ts) consumes. Pure and unit-testable in isolation from the RPC.
 * Every CoinFlipTables event indexes `tableId`, so a log missing it (or decoded positionally, i.e.
 * not an args object) is dropped rather than crashing the reducer on a malformed/foreign row.
 */
export const decodeTableLog = (log: TableLog): TableEvent | undefined => {
  const type = log.eventName
  const args = log.args
  if (!type || !args || Array.isArray(args)) return undefined
  const named = args as Record<string, unknown>
  const tableId = named.tableId as viem.Hex | undefined
  if (!tableId) return undefined
  return { ...named, type, tableId, blockNumber: log.blockNumber ?? 0n }
}

const fetchEvents = async (
  client: ReturnType<typeof publicClientFor>,
  address: viem.Hex,
  from: bigint,
  to: bigint,
): Promise<TableEvent[]> => {
  const out: TableEvent[] = []
  // Sequential, bounded chunks — same reasoning as useChainData's fetchViaLogs.
  for (let lo = from; lo <= to; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < to ? lo + MAX_RANGE - 1n : to
    const logs = await client.getContractEvents({ address, abi: coinFlipTablesAbi, fromBlock: lo, toBlock: hi, strict: true })
    for (const log of logs) {
      const event = decodeTableLog(log)
      if (event) out.push(event)
    }
  }
  return out
}

/**
 * Polls CoinFlipTables' on-chain events into the flat `TableEvent[]` that `reduceTables` turns into
 * `TableView[]`. Mirrors useChainData's getLogs idiom: a one-time chunked scan from the deploy block,
 * then incremental polling for only the blocks since the last read. There is no games-indexer support
 * for this contract yet, so (unlike useChainData) this always reads via eth_getLogs.
 *
 * Returns `{ events: [], head: 0n }` immediately — no RPC calls — when `deployment.coinFlipTables`
 * is unset, so the app builds and runs ahead of the contract's deployment (a later task fills in the
 * address).
 */
export const useTableEvents = (deployment: GameDeployment): TableEventsState => {
  const [state, setState] = useState<{ events: TableEvent[]; head: bigint; error?: string }>({ events: [], head: 0n })
  const busy = useRef(false)
  // Accumulated events + the highest block scanned, reset when the deployment/address changes.
  const acc = useRef<{ chainId: number; address: viem.Hex; events: TableEvent[]; lastBlock: bigint } | null>(null)

  const load = useCallback(async () => {
    const address = deployment.coinFlipTables
    if (!address || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const head = await client.getBlockNumber()
      if (!acc.current || acc.current.chainId !== deployment.chainId || acc.current.address !== address) {
        const startBlock = deployment.coinFlipTablesDeployBlock ? BigInt(deployment.coinFlipTablesDeployBlock) : 0n
        acc.current = { chainId: deployment.chainId, address, events: [], lastBlock: startBlock - 1n }
      }
      const from = acc.current.lastBlock + 1n
      if (head >= from) {
        const fresh = await fetchEvents(client, address, from, head)
        acc.current.events.push(...fresh)
        acc.current.lastBlock = head
      }
      setState({ events: acc.current.events, head, error: undefined })
    } catch (error) {
      setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment.chainId, deployment.rpc, deployment.coinFlipTables, deployment.coinFlipTablesDeployBlock])

  useEffect(() => {
    if (!deployment.coinFlipTables) {
      setState({ events: [], head: 0n })
      return
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load, deployment.coinFlipTables])

  return { ...state, refresh: () => void load() }
}
