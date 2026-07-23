import { useCallback, useEffect, useRef } from 'react'
import { hexToBytes, bytesToHex, type Hex } from 'viem'
import { createMsgBoardClient, post, type StampInput, type Stamp } from '@msgboard/games'

/** A lifecycle notice a player's table posts to the shared lobby (mirrors the bots' shape). */
export type LobbyNotice = { kind: 'open' | 'summary'; game: string; tableId?: string; [k: string]: unknown }

const STAMP_MAX_ITERS = 50_000_000 // ample for the 943 floor (~190k iters)

/**
 * Returns a `broadcast(notice)` that posts a lobby notice to MsgBoard from the BROWSER, with the
 * proof-of-work STAMP minted in a Web Worker (WASM build of the Rust grinder) — never on the UI
 * thread, which it would freeze. The thin RPC bits (read difficulty + head, then submit) run inline
 * via `post` (network, fine on the main thread). Drop-if-busy: one post at a time, the rest dropped
 * (the board is a live signal, not a log). No key ever crosses into the worker — these notices are
 * unsigned, and all session signing stays on the main thread.
 *
 * No-op when the deployment has no `boardRpc`. Reading the feed (`useBoardFeed`) needs no worker.
 */
export const useBoardBroadcaster = ({
  boardRpc,
  chainId,
}: {
  boardRpc: string | undefined
  chainId: number
}): ((n: LobbyNotice) => void) => {
  const workerRef = useRef<Worker | null>(null)
  const boardRef = useRef<ReturnType<typeof createMsgBoardClient> | null>(null)
  const busy = useRef(false)
  const seq = useRef(0)
  const jobs = useRef(new Map<number, { resolve: (s: Stamp) => void; reject: (e: Error) => void }>())

  useEffect(() => {
    if (!boardRpc) return
    boardRef.current = createMsgBoardClient(boardRpc)
    const worker = new Worker(new URL('../workers/powWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; packed?: Uint8Array; error?: string }>) => {
      const { id, packed, error } = e.data
      const job = jobs.current.get(id)
      if (!job) return
      jobs.current.delete(id)
      if (error || !packed) job.reject(new Error(error ?? 'stamp failed'))
      else job.resolve({ nonce: BigInt(bytesToHex(packed.slice(0, 8))), hash: bytesToHex(packed.slice(8)) as Hex })
    }
    worker.onerror = () => {
      for (const j of jobs.current.values()) j.reject(new Error('grinder worker error'))
      jobs.current.clear()
      busy.current = false
    }
    workerRef.current = worker
    return () => {
      worker.terminate()
      workerRef.current = null
      boardRef.current = null
      busy.current = false
      jobs.current.clear()
    }
  }, [boardRpc])

  // Mint the PoW stamp in the worker (off the UI thread). No key crosses over.
  const stamper = useCallback(
    (input: StampInput): Promise<Stamp> =>
      new Promise<Stamp>((resolve, reject) => {
        const worker = workerRef.current
        if (!worker) return reject(new Error('no grinder'))
        const id = ++seq.current
        jobs.current.set(id, { resolve, reject })
        worker.postMessage({
          id,
          category: hexToBytes(input.category),
          data: hexToBytes(input.data),
          wm: Number(input.workMultiplier),
          wd: Number(input.workDivisor),
          blockHash: hexToBytes(input.blockHash),
          maxIters: STAMP_MAX_ITERS,
        })
      }),
    [],
  )

  return useCallback(
    (notice: LobbyNotice) => {
      const board = boardRef.current
      if (!board || !boardRpc || busy.current) return // drop-if-busy — PoW + RPC take a moment
      busy.current = true
      void post({ board, category: `games.msgboard.xyz:lobby:${chainId}`, notice: { v: 1, at: Date.now(), ...notice }, stamp: stamper })
        .catch(() => {}) // best-effort live signal
        .finally(() => {
          busy.current = false
        })
    },
    [boardRpc, chainId, stamper],
  )
}
