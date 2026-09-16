import { useCallback, useEffect, useRef, useState } from 'react'
import { operatorCoinFlipAbi, operatorRegistryAbi } from '@msgboard/games-core'
import type { OperatorEvent } from '../lib/operatorIndex'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'

const POLL_MS = 12_000
// Chunk a getLogs scan so a full-history range never exceeds the RPC's per-request limit (same ceiling
// useChainData/useBackroomData scan under).
const MAX_RANGE = 10_000n

export type OperatorRoundsState = {
  events: OperatorEvent[]
  head: bigint
  error?: string
  refresh: () => void
}

/** Decimal-string args re-hydrated to bigint (hex/addresses/bools pass through) — same rule as
 *  useBackroomData's rehydrate. */
const rehydrate = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : v
  return out
}

/** Indexer GraphQL — reads ONLY `game = "operator"` rows, same shape as useBackroomData's fetch. */
const fetchViaIndexer = async (url: string, chainId: number, from: bigint, to: bigint): Promise<OperatorEvent[]> => {
  const out: OperatorEvent[] = []
  let after: string | null = null
  do {
    const query = `query($chainId: Int!, $from: BigInt!, $to: BigInt!, $after: String) {
      gameEvents(where: { chainId: $chainId, game: "operator", blockNumber_gte: $from, blockNumber_lte: $to }, orderBy: "blockNumber", orderDirection: "asc", limit: 1000, after: $after) {
        items { name args blockNumber }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { chainId, from: from.toString(), to: to.toString(), after } }),
    })
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`)
    const json = (await res.json()) as {
      errors?: { message: string }[]
      data?: { gameEvents: { items: { name: string; args: Record<string, unknown>; blockNumber: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    if (json.errors?.length) throw new Error(json.errors[0]!.message)
    const page = json.data?.gameEvents
    if (!page) break
    for (const e of page.items) out.push({ name: e.name, args: rehydrate(e.args ?? {}), blockNumber: BigInt(e.blockNumber) })
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return out
}

/** getLogs fallback (spec §9): scan OperatorCoinFlip (live + retired) and OperatorRegistry directly so a
 *  just-opened round and the operator's theme are visible even if the indexer lags or is unset. */
const fetchViaLogs = async (
  client: ReturnType<typeof publicClientFor>,
  opCfg: NonNullable<GameDeployment['operator']>,
  from: bigint,
  to: bigint,
): Promise<OperatorEvent[]> => {
  const out: OperatorEvent[] = []
  const coinFlipAddresses = [opCfg.coinFlip, ...opCfg.retired]
  for (let lo = from; lo <= to; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < to ? lo + MAX_RANGE - 1n : to
    const [game, registry] = await Promise.all([
      client.getContractEvents({ address: coinFlipAddresses, abi: operatorCoinFlipAbi, fromBlock: lo, toBlock: hi, strict: true }),
      client.getContractEvents({ address: opCfg.registry, abi: operatorRegistryAbi, fromBlock: lo, toBlock: hi, strict: true }),
    ])
    for (const log of [...game, ...registry]) {
      out.push({ name: log.eventName, args: (log.args ?? {}) as Record<string, any>, blockNumber: log.blockNumber ?? 0n })
    }
  }
  return out
}

/**
 * Poll the operator substrate's raw event stream (every operator's tables + rounds + metadata). Reads the
 * indexer's GraphQL when `deployment.gamesIndexer` is set, chunked getLogs otherwise or on an indexer
 * failure. Accumulate-only cache keyed by chain, POLL_MS 12000. Returns `{ events: [], head: 0n }` with no
 * RPC calls when the chain carries no operator substrate (369), so the app builds and runs there unchanged.
 */
export const useOperatorRounds = (deployment: GameDeployment): OperatorRoundsState => {
  const [state, setState] = useState<{ events: OperatorEvent[]; head: bigint; error?: string }>({ events: [], head: 0n })
  const busy = useRef(false)
  const acc = useRef<{ chainId: number; events: OperatorEvent[]; lastBlock: bigint } | null>(null)

  const load = useCallback(async () => {
    const opCfg = deployment.operator
    if (!opCfg || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const head = await client.getBlockNumber()
      if (!acc.current || acc.current.chainId !== deployment.chainId) {
        acc.current = { chainId: deployment.chainId, events: [], lastBlock: BigInt(opCfg.deployBlock) - 1n }
      }
      const from = acc.current.lastBlock + 1n
      if (head >= from) {
        let fresh: OperatorEvent[]
        if (deployment.gamesIndexer) {
          try {
            fresh = await fetchViaIndexer(deployment.gamesIndexer, deployment.chainId, from, head)
          } catch {
            fresh = await fetchViaLogs(client, opCfg, from, head)
          }
        } else {
          fresh = await fetchViaLogs(client, opCfg, from, head)
        }
        acc.current.events.push(...fresh)
        acc.current.lastBlock = head
      }
      setState({ events: acc.current.events, head, error: undefined })
    } catch (error) {
      setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment.chainId, deployment.rpc, deployment.gamesIndexer, deployment.operator])

  useEffect(() => {
    if (!deployment.operator) {
      setState({ events: [], head: 0n })
      return
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load, deployment.operator])

  return { ...state, refresh: () => void load() }
}
