import { useCallback, useEffect, useRef, useState } from 'react'
import * as viem from 'viem'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'
import { sudokuLogAbi, knownPuzzleGrid, verifyPuzzleGrid } from '../lib/sudokuContract'

const POLL_MS = 15_000
// Chunk getLogs so a full-history range never exceeds the RPC's per-request limit (same guard as
// useChainData — valve returns "Request exceeds defined limit" on very wide ranges).
const MAX_RANGE = 10_000n

/** The published board for a puzzle id, once verified against the on-chain puzzleHash. */
export type PuzzleState = {
  puzzleId: bigint
  opened: boolean
  openedAt: number
  puzzleHash?: viem.Hex
  /** The verified 81-cell grid (present only when we hold the matching board). */
  grid?: number[]
  /** Set when the puzzle is opened but we have no locally-known grid, or it fails the hash check. */
  gridProblem?: string
}

/** One leaderboard row (a Solved entry), ranked by elapsed ascending. */
export type LeaderboardRow = {
  rank: number
  player: bigint
  nullifier: bigint
  solvedAt: number
  elapsed: number
}

export type SudokuData = {
  puzzle?: PuzzleState
  leaderboard: LeaderboardRow[]
  source: 'indexer' | 'logs' | 'none'
  blockNumber: bigint
  loading: boolean
  error?: string
  refresh: () => void
}

const rankRows = (rows: Omit<LeaderboardRow, 'rank'>[]): LeaderboardRow[] =>
  [...rows]
    .sort((a, b) => (a.elapsed === b.elapsed ? a.solvedAt - b.solvedAt : a.elapsed - b.elapsed))
    .map((r, i) => ({ ...r, rank: i + 1 }))

// ── indexer source (Ponder GraphQL) ──────────────────────────────────────────────────────────────
// Best-effort: the sudoku_solve leaderboard table's exact GraphQL shape depends on the deployed
// indexer schema. Any error here (table absent, field mismatch) falls through to the getLogs scan.
const fetchViaIndexer = async (url: string, puzzleId: bigint): Promise<Omit<LeaderboardRow, 'rank'>[]> => {
  const query = `query($puzzleId: BigInt!) {
    sudoku_solves(where: { puzzleId: $puzzleId }, orderBy: "elapsed", orderDirection: "asc", limit: 1000) {
      items { player nullifier solvedAt elapsed }
    }
  }`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { puzzleId: puzzleId.toString() } }),
  })
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`)
  const json = (await res.json()) as {
    errors?: { message: string }[]
    data?: { sudoku_solves?: { items: { player: string; nullifier: string; solvedAt: string; elapsed: string }[] } }
  }
  if (json.errors?.length) throw new Error(json.errors[0]!.message)
  const items = json.data?.sudoku_solves?.items
  if (!items) throw new Error('indexer: no sudoku_solves table')
  return items.map((it) => ({
    player: BigInt(it.player),
    nullifier: BigInt(it.nullifier),
    solvedAt: Number(it.solvedAt),
    elapsed: Number(it.elapsed),
  }))
}

// ── logs source (fallback) ────────────────────────────────────────────────────────────────────────
const fetchViaLogs = async (
  client: ReturnType<typeof publicClientFor>,
  sudokuLog: viem.Hex,
  fromBlock: bigint,
  head: bigint,
  puzzleId: bigint,
): Promise<Omit<LeaderboardRow, 'rank'>[]> => {
  const rows: Omit<LeaderboardRow, 'rank'>[] = []
  for (let lo = fromBlock; lo <= head; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < head ? lo + MAX_RANGE - 1n : head
    const logs = await client.getContractEvents({
      address: sudokuLog,
      abi: sudokuLogAbi,
      eventName: 'Solved',
      args: { puzzleId },
      fromBlock: lo,
      toBlock: hi,
      strict: true,
    })
    for (const l of logs) {
      const a = l.args as { player?: bigint; nullifier?: bigint; solvedAt?: bigint; elapsed?: bigint }
      if (a.player === undefined) continue
      rows.push({
        player: a.player,
        nullifier: a.nullifier ?? 0n,
        solvedAt: Number(a.solvedAt ?? 0n),
        elapsed: Number(a.elapsed ?? 0n),
      })
    }
  }
  return rows
}

/**
 * Reads a SudokuLog puzzle + its leaderboard for the active chain. The puzzle grid itself is NOT
 * on-chain (only its hash), so we pair the on-chain puzzleHash with a locally-known board and verify
 * they match before letting the user play. The leaderboard reads from the games indexer when set,
 * else falls back to a chunked `Solved` getLogs scan from skillDeployBlock.
 */
export const useSudoku = (deployment: GameDeployment | null, puzzleId: bigint): SudokuData => {
  const [data, setData] = useState<Omit<SudokuData, 'refresh'>>({
    leaderboard: [],
    source: 'none',
    blockNumber: 0n,
    loading: false,
  })
  const busy = useRef(false)

  const load = useCallback(async () => {
    if (!deployment?.sudokuLog || busy.current) return
    const sudokuLog = deployment.sudokuLog
    busy.current = true
    setData((d) => ({ ...d, loading: true }))
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const head = await client.getBlockNumber()

      // ── puzzle read + grid verification ──
      const [puzzleHash, openedAt] = (await client.readContract({
        address: sudokuLog,
        abi: sudokuLogAbi,
        functionName: 'puzzles',
        args: [puzzleId],
      })) as [viem.Hex, bigint]
      const opened = openedAt !== 0n
      const known = knownPuzzleGrid(puzzleId)
      let grid: number[] | undefined
      let gridProblem: string | undefined
      if (opened) {
        if (!known) {
          gridProblem = 'no locally-known board for this puzzle id — cannot play (only its hash is on-chain)'
        } else if (!verifyPuzzleGrid(known, puzzleHash)) {
          gridProblem = 'the known board does not match the on-chain puzzleHash — refusing to play the wrong puzzle'
        } else {
          grid = known
        }
      }
      const puzzle: PuzzleState = {
        puzzleId,
        opened,
        openedAt: Number(openedAt),
        puzzleHash,
        grid,
        gridProblem,
      }

      // ── leaderboard: indexer, else getLogs ──
      let rows: Omit<LeaderboardRow, 'rank'>[] = []
      let source: 'indexer' | 'logs' = 'logs'
      if (deployment.gamesIndexer) {
        try {
          rows = await fetchViaIndexer(deployment.gamesIndexer, puzzleId)
          source = 'indexer'
        } catch {
          rows = [] // fall through to logs below
        }
      }
      if (source === 'logs') {
        const fromBlock = BigInt(deployment.skillDeployBlock ?? deployment.deployBlock)
        rows = await fetchViaLogs(client, sudokuLog, fromBlock, head, puzzleId)
      }

      setData({
        puzzle,
        leaderboard: rankRows(rows),
        source,
        blockNumber: head,
        loading: false,
        error: undefined,
      })
    } catch (error) {
      setData((d) => ({ ...d, loading: false, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment, puzzleId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  return { ...data, refresh: () => void load() }
}

/** One-shot check that a nullifier hasn't already been spent (would revert logSolve). */
export const checkNullifierSpent = async (
  deployment: GameDeployment,
  nullifier: bigint,
): Promise<boolean> => {
  if (!deployment.sudokuLog) return false
  const client = publicClientFor(deployment.chainId, deployment.rpc)
  return (await client.readContract({
    address: deployment.sudokuLog,
    abi: sudokuLogAbi,
    functionName: 'spentNullifier',
    args: [nullifier],
  })) as boolean
}
