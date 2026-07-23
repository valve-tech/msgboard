import { useCallback, useEffect, useRef, useState } from 'react'
import * as viem from 'viem'
import type { GameDeployment } from '../config'

const POLL_MS = 30_000

/** One player's aggregate across every settled game on this chain. */
export type StandingRow = {
  rank: number
  player: viem.Hex
  /** Settlements this address collected (wins + default claims). */
  wins: number
  /** Total collected across those settlements, in PLS-equivalents (x402PLS is 1:1 wrapped PLS). */
  collected: bigint
  /** Per-game win counts, for the breakdown chips. */
  byGame: Record<string, number>
}

/** One player's proof-gated solve count (the EAS facts rail — no wagers, pure skill receipts). */
export type SolverRow = {
  rank: number
  player: viem.Hex
  solves: number
  byGame: Record<string, number>
  /** Unix seconds of the most recent attested solve. */
  lastAt: number
}

export type StandingsData = {
  rows: StandingRow[]
  solvers: SolverRow[]
  loading: boolean
  error?: string
  refresh: () => void
}

type EventRow = { game: string; name: string; args: Record<string, string | number | boolean> }

/**
 * How each terminal event names its collector and amount. Standings are GROSS collections (pots +
 * default claims), not net P&L — outflows (stakes paid in) aren't events, and folding them per
 * address per game would triple the query surface for a number the receipts already imply.
 */
const COLLECTORS: Record<string, { winner: string; amount: string }> = {
  'coinflip:Settled': { winner: 'winner', amount: 'payout' },
  'raffle:Finalised': { winner: 'winner', amount: 'payout' },
  'flipbook:Revealed': { winner: 'winner', amount: 'pot' },
  'flipbook:Forfeited': { winner: 'taker', amount: 'amount' },
  'flipbookx:Settled': { winner: 'winner', amount: 'pot' },
  'flipbookx:MakerDefaulted': { winner: 'taker', amount: 'amount' },
  'flipbookx:TakerDefaulted': { winner: 'maker', amount: 'amount' },
}

const fetchSettlements = async (url: string, chainId: number): Promise<EventRow[]> => {
  const out: EventRow[] = []
  let after: string | null = null
  do {
    const query = `query($chainId: Int!, $after: String) {
      gameEvents(
        where: { chainId: $chainId, name_in: ["Settled", "Finalised", "Revealed", "Forfeited", "MakerDefaulted", "TakerDefaulted"] }
        orderBy: "blockNumber", orderDirection: "asc", limit: 1000, after: $after
      ) {
        items { game name args }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { chainId, after } }),
    })
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`)
    const json = (await res.json()) as {
      errors?: { message: string }[]
      data?: { gameEvents: { items: EventRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    if (json.errors?.length) throw new Error(json.errors[0]!.message)
    const page = json.data?.gameEvents
    if (!page) break
    out.push(...page.items)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return out
}

export type SolveRow = { game: string; solver: string; blockTimestamp: string }

const fetchSolves = async (url: string, chainId: number): Promise<SolveRow[]> => {
  const out: SolveRow[] = []
  let after: string | null = null
  do {
    const query = `query($chainId: Int!, $after: String) {
      solveAttestations(
        where: { chainId: $chainId }
        orderBy: "blockNumber", orderDirection: "asc", limit: 1000, after: $after
      ) {
        items { game solver blockTimestamp }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { chainId, after } }),
    })
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`)
    const json = (await res.json()) as {
      errors?: { message: string }[]
      data?: { solveAttestations: { items: SolveRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    if (json.errors?.length) throw new Error(json.errors[0]!.message)
    const page = json.data?.solveAttestations
    if (!page) break
    out.push(...page.items)
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return out
}

export const foldSolves = (solves: SolveRow[]): SolverRow[] => {
  const byPlayer = new Map<string, { solves: number; byGame: Record<string, number>; lastAt: number }>()
  for (const s of solves) {
    const key = s.solver.toLowerCase()
    const cur = byPlayer.get(key) ?? { solves: 0, byGame: {}, lastAt: 0 }
    cur.solves += 1
    cur.byGame[s.game] = (cur.byGame[s.game] ?? 0) + 1
    cur.lastAt = Math.max(cur.lastAt, Number(s.blockTimestamp))
    byPlayer.set(key, cur)
  }
  return [...byPlayer.entries()]
    .map(([player, s]) => ({ player: viem.getAddress(player) as viem.Hex, ...s, rank: 0 }))
    .sort((a, b) => (a.solves === b.solves ? b.lastAt - a.lastAt : b.solves - a.solves))
    .map((r, i) => ({ ...r, rank: i + 1 }))
}

const fold = (events: EventRow[]): StandingRow[] => {
  const byPlayer = new Map<string, { wins: number; collected: bigint; byGame: Record<string, number> }>()
  for (const e of events) {
    const spec = COLLECTORS[`${e.game}:${e.name}`]
    if (!spec) continue // raffle 'Revealed' ticket events etc. share names — spec keys are exact
    const winner = e.args[spec.winner]
    const amount = e.args[spec.amount]
    if (typeof winner !== 'string' || !winner.startsWith('0x')) continue
    const key = winner.toLowerCase()
    const cur = byPlayer.get(key) ?? { wins: 0, collected: 0n, byGame: {} }
    cur.wins += 1
    cur.collected += typeof amount === 'string' ? BigInt(amount) : 0n
    cur.byGame[e.game] = (cur.byGame[e.game] ?? 0) + 1
    byPlayer.set(key, cur)
  }
  return [...byPlayer.entries()]
    .map(([player, s]) => ({ player: viem.getAddress(player) as viem.Hex, ...s, rank: 0 }))
    .sort((a, b) => (a.collected === b.collected ? b.wins - a.wins : a.collected < b.collected ? 1 : -1))
    .map((r, i) => ({ ...r, rank: i + 1 }))
}

/**
 * "Who is winning" — folded from the games indexer's terminal events across every wagered game
 * (validator coinflip, the numbers, both flip books). One paginated GraphQL query per poll;
 * no chain scanning. Requires `gamesIndexer` on the deployment.
 */
export const useStandings = (deployment: GameDeployment | null): StandingsData => {
  const [data, setData] = useState<Omit<StandingsData, 'refresh'>>({ rows: [], solvers: [], loading: false })
  const busy = useRef(false)

  const load = useCallback(async () => {
    if (!deployment?.gamesIndexer || busy.current) return
    busy.current = true
    setData((d) => ({ ...d, loading: true }))
    try {
      const [events, solves] = await Promise.all([
        fetchSettlements(deployment.gamesIndexer, deployment.chainId),
        // Solves degrade to empty rather than sinking the winnings table — an indexer that predates
        // the solve_attestation table answers this query with an unknown-field error.
        fetchSolves(deployment.gamesIndexer, deployment.chainId).catch(() => [] as SolveRow[]),
      ])
      setData({ rows: fold(events), solvers: foldSolves(solves), loading: false, error: undefined })
    } catch (error) {
      setData((d) => ({ ...d, loading: false, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  return { ...data, refresh: () => void load() }
}
