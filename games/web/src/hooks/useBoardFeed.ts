import { useEffect, useRef, useState } from 'react'
import { createBoardClient, MsgBoardTransport } from '@msgboard/games'
import type { GameDeployment } from '../config'

/** A lifecycle notice the session bots (and, later, players) post to the shared lobby category. */
export type BoardNotice = {
  v?: number
  tableId?: string
  at?: number
  kind?: 'open' | 'summary'
  game?: string
  /** open: commit/player/deck/escrowEach/mines/tiles; summary: rounds/balance/reveals/busted/delta/flips/balA/balB. */
  [k: string]: unknown
}

/** The category the bots broadcast to — must match session-bots.ts: `games.msgboard.xyz:lobby:<chain>`. */
const lobbyCategory = (chainId: number): string => `games.msgboard.xyz:lobby:${chainId}`

/**
 * Reads the LIVE session-game feed off MsgBoard: the bots post a notice when a table opens and when
 * it settles, all to one shared `mbg:lobby:<chain>` category. Reading needs no proof-of-work, so this
 * just polls `content()` on an interval. The board is ephemeral (~120 blocks), so it naturally shows
 * only recent activity. Returns notices newest-first.
 */
export const useBoardFeed = (deployment: GameDeployment, pollMs = 15_000): BoardNotice[] => {
  const [notices, setNotices] = useState<BoardNotice[]>([])
  const seen = useRef<Set<string>>(new Set())

  useEffect(() => {
    const rpc = deployment.boardRpc
    if (!rpc) {
      setNotices([])
      return
    }
    seen.current = new Set()
    setNotices([])
    let stop = false
    const transport = new MsgBoardTransport(createBoardClient(rpc), { category: lobbyCategory(deployment.chainId) })
    transport.onMessage((m) => {
      const n = m as BoardNotice
      const key = JSON.stringify(n)
      if (seen.current.has(key)) return
      seen.current.add(key)
      setNotices((prev) => [n, ...prev].slice(0, 50))
    })
    const tick = async () => {
      try {
        await transport.poll()
      } catch {
        // best-effort: a transient board/RPC hiccup just skips this tick.
      }
    }
    void tick()
    const id = setInterval(() => {
      if (!stop) void tick()
    }, pollMs)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [deployment.boardRpc, deployment.chainId, pollMs])

  // newest-first by post time (falls back to insertion order when `at` is absent).
  return [...notices].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}
