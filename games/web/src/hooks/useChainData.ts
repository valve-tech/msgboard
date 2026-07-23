import { useCallback, useEffect, useRef, useState } from 'react'
import * as viem from 'viem'
import { coinFlipAbi, raffleAbi } from '@msgboard/games-core'
import { deriveCoinFlipLobby, type CoinFlipLobby } from '../model/coinflip-lobby'
import { deriveRaffleRounds, type RaffleRoundView } from '../model/raffle-rounds'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'

const POLL_MS = 12_000
// Chunk a getLogs scan so a full-history range never exceeds the RPC's per-request range/response
// limit (valve returns "Request exceeds defined limit" on a 38k-block all-event query).
const MAX_RANGE = 10_000n

export type ChainData = {
  lobby: CoinFlipLobby
  rounds: RaffleRoundView[]
  blockNumber: bigint
  timestamps: Record<string, number>
  error?: string
  refresh: () => void
}

const emptyLobby: CoinFlipLobby = { openEntries: [], flips: [] }

/** Normalised event row, the common shape both sources (getLogs / the indexer) produce. */
type RawEvent = {
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint
  transactionHash?: viem.Hex
  blockTimestamp?: number
}

/** Partition events by name into the `{ ...args, blockNumber, transactionHash }` shape the models want. */
const pick = <T,>(events: readonly RawEvent[], name: string): T[] =>
  events
    .filter((e) => e.eventName === name)
    .map((e) => ({ ...e.args, blockNumber: e.blockNumber, transactionHash: e.transactionHash }) as T)

const timestampCache = new Map<string, number>()

// ── getLogs source (fallback / when no indexer is configured) ───────────────────────────────────
const fetchViaLogs = async (
  client: ReturnType<typeof publicClientFor>,
  deployment: GameDeployment,
  from: bigint,
  to: bigint,
): Promise<RawEvent[]> => {
  const norm = (logs: readonly { eventName?: string; args?: unknown; blockNumber?: bigint | null; transactionHash?: viem.Hex | null }[]): RawEvent[] =>
    logs.map((l) => ({
      eventName: l.eventName ?? '',
      args: (l.args ?? {}) as Record<string, unknown>,
      blockNumber: l.blockNumber ?? 0n,
      transactionHash: l.transactionHash ?? undefined,
    }))
  const out: RawEvent[] = []
  // Sequential, bounded chunks — keeps each request under the RPC limit and spreads CU over time.
  for (let lo = from; lo <= to; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < to ? lo + MAX_RANGE - 1n : to
    const [cf, rf] = await Promise.all([
      client.getContractEvents({ address: deployment.coinFlip, abi: coinFlipAbi, fromBlock: lo, toBlock: hi, strict: true }),
      client.getContractEvents({ address: deployment.raffle, abi: raffleAbi, fromBlock: lo, toBlock: hi, strict: true }),
    ])
    out.push(...norm(cf), ...norm(rf))
  }
  return out
}

/** Block timestamps for the getLogs path (the indexer path already carries them). Cached per chain. */
const resolveTimestamps = async (
  client: ReturnType<typeof publicClientFor>,
  chainId: number,
  events: RawEvent[],
): Promise<Record<string, number>> => {
  const blocks = new Set(events.map((e) => e.blockNumber.toString()))
  const missing = [...blocks].filter((b) => !timestampCache.has(`${chainId}:${b}`))
  // Cap per-poll getBlock calls so a big first scan doesn't burst the RPC; uncached ones fill in later.
  for (const b of missing.slice(0, 40)) {
    const block = await client.getBlock({ blockNumber: BigInt(b) })
    timestampCache.set(`${chainId}:${b}`, Number(block.timestamp))
  }
  const out: Record<string, number> = {}
  for (const b of blocks) {
    const ts = timestampCache.get(`${chainId}:${b}`)
    if (ts !== undefined) out[b] = ts
  }
  return out
}

// ── indexer source (GraphQL) — used when `deployment.gamesIndexer` is set ────────────────────────
/** Decimal-string args are re-hydrated to bigint (hex/addresses stay strings; numbers/bools untouched). */
const rehydrate = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : v
  return out
}

const fetchViaIndexer = async (url: string, chainId: number, from: bigint, to: bigint): Promise<RawEvent[]> => {
  const out: RawEvent[] = []
  let after: string | null = null
  // Ponder cursor pagination; only the new [from, to] window each poll. The indexer serves BOTH
  // chains and the flipbook from one gameEvent table, so filter by chainId + game here — Raffle and
  // FlipBook even share an event name ('Revealed'); name alone is not an identity.
  do {
    const query = `query($chainId: Int!, $from: BigInt!, $to: BigInt!, $after: String) {
      gameEvents(where: { chainId: $chainId, game_in: ["coinflip", "raffle"], blockNumber_gte: $from, blockNumber_lte: $to }, orderBy: "blockNumber", orderDirection: "asc", limit: 1000, after: $after) {
        items { name args blockNumber blockTimestamp txHash }
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
      data?: { gameEvents: { items: { name: string; args: Record<string, unknown>; blockNumber: string; blockTimestamp: string; txHash: viem.Hex }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    if (json.errors?.length) throw new Error(json.errors[0]!.message)
    const page = json.data?.gameEvents
    if (!page) break
    for (const e of page.items) {
      out.push({
        eventName: e.name,
        args: rehydrate(e.args ?? {}),
        blockNumber: BigInt(e.blockNumber),
        transactionHash: e.txHash,
        blockTimestamp: Number(e.blockTimestamp),
      })
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return out
}

/**
 * Polls both games' on-chain events into the lobby/round models. Reads from the games indexer's
 * GraphQL when `deployment.gamesIndexer` is set (no chain scanning at all); otherwise falls back to
 * INCREMENTAL, chunked getLogs — only blocks since the last poll, the one-time history scan split
 * into bounded ranges so it never floods or exceeds the RPC's limits.
 */
export const useChainData = (deployment: GameDeployment | null, myAddress?: viem.Hex): ChainData => {
  const [data, setData] = useState<Omit<ChainData, 'refresh'>>({
    lobby: emptyLobby,
    rounds: [],
    blockNumber: 0n,
    timestamps: {},
  })
  const busy = useRef(false)
  // Accumulated events + the highest block scanned, reset when the deployment changes.
  const acc = useRef<{ chainId: number; events: RawEvent[]; lastBlock: bigint } | null>(null)

  const load = useCallback(async () => {
    if (!deployment || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const head = await client.getBlockNumber()
      if (!acc.current || acc.current.chainId !== deployment.chainId) {
        acc.current = { chainId: deployment.chainId, events: [], lastBlock: BigInt(deployment.deployBlock) - 1n }
      }
      const from = acc.current.lastBlock + 1n
      if (head >= from) {
        const fresh = deployment.gamesIndexer
          ? await fetchViaIndexer(deployment.gamesIndexer, deployment.chainId, from, head)
          : await fetchViaLogs(client, deployment, from, head)
        acc.current.events.push(...fresh)
        acc.current.lastBlock = head
      }
      const events = acc.current.events
      const timestamps = deployment.gamesIndexer
        ? Object.fromEntries(events.filter((e) => e.blockTimestamp !== undefined).map((e) => [e.blockNumber.toString(), e.blockTimestamp!]))
        : await resolveTimestamps(client, deployment.chainId, events)
      setData({
        blockNumber: head,
        timestamps,
        lobby: deriveCoinFlipLobby(
          {
            entered: pick(events, 'Entered'),
            cancelled: pick(events, 'Cancelled'),
            paired: pick(events, 'Paired'),
            heated: pick(events, 'Heated'),
            settled: pick(events, 'Settled'),
          },
          myAddress,
        ),
        rounds: deriveRaffleRounds(
          {
            opened: pick(events, 'RoundOpened'),
            committed: pick(events, 'Committed'),
            ticketCancelled: pick(events, 'TicketCancelled'),
            armed: pick(events, 'Armed'),
            drawn: pick(events, 'Drawn'),
            revealed: pick(events, 'Revealed'),
            finalised: pick(events, 'Finalised'),
            noContest: pick(events, 'NoContest'),
            ticketRefunded: pick(events, 'TicketRefunded'),
          },
          myAddress,
          head,
        ),
        error: undefined,
      })
    } catch (error) {
      setData((d) => ({ ...d, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment, myAddress])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  return { ...data, refresh: () => void load() }
}
