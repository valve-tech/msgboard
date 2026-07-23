import { useCallback, useEffect, useRef, useState } from 'react'
import { bytesToHex, hexToBytes, type Hex } from 'viem'
import {
  createBoardClient,
  createMsgBoardClient,
  post,
  MsgBoardTransport,
  type StampInput,
  type Stamp,
} from '@msgboard/games'

// ── the setter↔guesser wire protocol on one shared per-challenge category ──────────────────────────
// Both roles POST to and READ from `games.msgboard.xyz:wordle:<chain>:<challengeId>`. Reading needs no
// proof-of-work (just polls `content()`); POSTING mints the PoW stamp in a Web Worker (never the UI
// thread — the hard project rule), exactly like useBoardBroadcaster. The board is ephemeral (~120
// blocks), so a fresh poll naturally re-hydrates a recently-active challenge.

/** A single message in the Wordle exchange. `id` de-dupes; `t` is the kind. */
export type WordleMsg =
  | { v: 1; t: 'open'; id: string; challengeId: string; commit: string; setter: Hex; word?: undefined; at: number }
  /** a guesser submits a guess (letter indices 0-25). `n` is the 0-based guess number for that guesser. */
  | { v: 1; t: 'guess'; id: string; challengeId: string; guesser: Hex; n: number; guess: number[]; at: number }
  /** the setter returns the honest clue + wordle_clue proof for a specific guess. */
  | {
      v: 1
      t: 'clue'
      id: string
      challengeId: string
      guesser: Hex
      n: number
      clue: number[]
      proof: unknown
      publicSignals: string[]
      at: number
    }
  /** the setter reveals word+salt (letter indices + decimal salt) — enables the OPTIONAL solve proof. */
  | { v: 1; t: 'reveal'; id: string; challengeId: string; word: number[]; salt: string; at: number }
  /** a guesser announces a verified win (guesses-used). Informational for the board/leaderboard. */
  | { v: 1; t: 'win'; id: string; challengeId: string; guesser: Hex; guessesUsed: number; at: number }

const STAMP_MAX_ITERS = 50_000_000 // ample for the 943/369 floor (mirrors useBoardBroadcaster)
const POLL_MS = 5_000

/** The one shared category name both roles derive for a challenge (categoryHash aligns poster+reader). */
export const wordleCategory = (chainId: number, challengeId: string): string =>
  `games.msgboard.xyz:wordle:${chainId}:${challengeId}`

export type WordleBoard = {
  /** true once the PoW worker + board client are up and a challengeId is set. */
  ready: boolean
  /** every message seen on the category, deduped by `id`, oldest-first (a reducible transcript). */
  messages: WordleMsg[]
  /** post a message; mints PoW in the worker then submits. Rejects on failure (never silently drops). */
  post: (msg: WordleMsg) => Promise<void>
}

/**
 * Live msgboard transport for ONE Wordle challenge. Set `challengeId` to null to stay idle (no polling,
 * post rejects). Posting is serialized through a small queue so a burst (e.g. several clue replies) each
 * lands rather than being dropped.
 */
export const useWordleBoard = ({
  boardRpc,
  chainId,
  challengeId,
}: {
  boardRpc: string | undefined
  chainId: number
  challengeId: string | null
}): WordleBoard => {
  const [messages, setMessages] = useState<WordleMsg[]>([])
  const [ready, setReady] = useState(false)

  const powWorkerRef = useRef<Worker | null>(null)
  const postBoardRef = useRef<ReturnType<typeof createMsgBoardClient> | null>(null)
  const seq = useRef(0)
  const jobs = useRef(new Map<number, { resolve: (s: Stamp) => void; reject: (e: Error) => void }>())
  const seen = useRef<Set<string>>(new Set())
  const postChain = useRef<Promise<unknown>>(Promise.resolve())

  // Spin up the PoW worker + the submit-side board client once per boardRpc.
  useEffect(() => {
    if (!boardRpc) {
      setReady(false)
      return
    }
    postBoardRef.current = createMsgBoardClient(boardRpc)
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
    }
    powWorkerRef.current = worker
    setReady(true)
    return () => {
      worker.terminate()
      powWorkerRef.current = null
      postBoardRef.current = null
      jobs.current.clear()
      setReady(false)
    }
  }, [boardRpc])

  // Poll the per-challenge category and accumulate new messages (deduped by `id`).
  useEffect(() => {
    setMessages([])
    seen.current = new Set()
    if (!boardRpc || !challengeId) return
    let stop = false
    const transport = new MsgBoardTransport(createBoardClient(boardRpc), {
      category: wordleCategory(chainId, challengeId),
    })
    transport.onMessage((m) => {
      const msg = m as WordleMsg
      if (!msg || typeof msg !== 'object' || !('id' in msg) || seen.current.has(msg.id)) return
      seen.current.add(msg.id)
      setMessages((prev) => [...prev, msg].sort((a, b) => a.at - b.at))
    })
    const tick = async () => {
      try {
        await transport.poll()
      } catch {
        // best-effort: a transient board/RPC hiccup just skips this tick.
      }
    }
    void tick()
    const timer = setInterval(() => {
      if (!stop) void tick()
    }, POLL_MS)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [boardRpc, chainId, challengeId])

  // Mint one PoW stamp in the worker (off the UI thread). No key ever crosses over.
  const stamper = useCallback(
    (input: StampInput): Promise<Stamp> =>
      new Promise<Stamp>((resolve, reject) => {
        const worker = powWorkerRef.current
        if (!worker) return reject(new Error('no grinder worker'))
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

  const postMsg = useCallback(
    (msg: WordleMsg): Promise<void> => {
      const board = postBoardRef.current
      if (!board || !boardRpc || !challengeId) return Promise.reject(new Error('board not ready'))
      // Serialize posts: each mints PoW then submits, so a burst queues rather than racing/dropping.
      const run = postChain.current
        .catch(() => {})
        .then(() =>
          post({ board, category: wordleCategory(chainId, challengeId), notice: msg, stamp: stamper }).then(() => {
            // Optimistically reflect our own post immediately (poll would also pick it up).
            if (!seen.current.has(msg.id)) {
              seen.current.add(msg.id)
              setMessages((prev) => [...prev, msg].sort((a, b) => a.at - b.at))
            }
          }),
        )
      postChain.current = run
      return run
    },
    [boardRpc, chainId, challengeId, stamper],
  )

  return { ready, messages, post: postMsg }
}
