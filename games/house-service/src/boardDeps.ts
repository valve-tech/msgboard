/**
 * boardDeps.ts — the PRODUCTION `HouseDeps` for `startHouse`, backed by a real MsgBoard category.
 *
 * `startHouse` (houseLoop.ts) is transport-agnostic: it consumes an async feed of inbound messages,
 * posts replies, and asks for a per-table co-sign transport. Task 4 tested it with in-memory fakes.
 * This module supplies the real wiring over the shared `houseCategory(chainId)`:
 *
 *   - `messages`      — a feed that polls the board and yields ONLY the player-sent kinds the house
 *                       acts on (open-request, round-request). Echoed/own posts are filtered out.
 *   - `postMessage`   — sends a house reply (open-grant/decline, round-transcript/decline) on the
 *                       shared category, bigint-encoded with the same wire codec the player uses.
 *   - `makeTransport` — a board-backed `makeBoardHouseCoSign` per table; its `request()` posts a
 *                       `cosign-req` and awaits the player's `cosign-rep`. (The returned `playerT`
 *                       is never used on the house side — the house only drives `houseT`.)
 *   - `getHeadBlock`  — supplied by the caller (a viem public client in production).
 *
 * The feed and the co-sign channel are SEPARATE MsgBoardTransport instances on the same category
 * because each transport holds a single handler; their kind filters are disjoint, so polling the
 * full category twice is correct (just slightly redundant).
 */
import type { Hex } from 'viem'
import {
  MsgBoardTransport,
  makeBoardHouseCoSign,
  toWire,
  fromWire,
  type BoardClient,
  type CoSignTransport,
} from '@msgboard/games'
import { houseCategory, isOpenRequest, isRoundRequest } from '@msgboard/settle'
import type { HouseDeps } from './houseLoop'

export interface BoardHouseDepsOpts {
  board: BoardClient
  chainId: number
  /** Current chain head block, for grant expiry. A viem `publicClient.getBlockNumber` in production. */
  getHeadBlock(): Promise<bigint>
  /** Poll cadence (ms) for the feed + co-sign channels. Default 1000. */
  pollMs?: number
  /** How long a co-sign `request()` waits for the player's half (ms). Default 120000. */
  timeoutMs?: number
}

const END = Symbol('board-house-deps-end')

/** Build the production `HouseDeps` plus a `stop()` that halts the feed poll loop. */
export function makeBoardHouseDeps(opts: BoardHouseDepsOpts): { deps: HouseDeps; stop(): void } {
  const { board, chainId, getHeadBlock } = opts
  const pollMs = opts.pollMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 120_000
  const cat = houseCategory(chainId)

  // The feed transport: receives every message in the category; we keep only open/round-requests.
  const feed = new MsgBoardTransport(board, cat)

  // A minimal async channel: poll pushes inbound requests, the generator pulls them.
  const queue: unknown[] = []
  const waiters: Array<(v: unknown) => void> = []
  const push = (m: unknown) => {
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  }
  const pull = (): Promise<unknown> =>
    new Promise((res) => {
      if (queue.length > 0) res(queue.shift())
      else waiters.push(res)
    })

  feed.onMessage((raw) => {
    const msg = fromWire(raw) // restore bigints (open-request stake/params, round-request stake/params)
    if (isOpenRequest(msg) || isRoundRequest(msg)) push(msg)
  })

  let running = true
  const pollLoop = async () => {
    while (running) {
      try { await feed.poll() } catch { /* transient board error — keep polling until stop() */ }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
  void pollLoop()

  async function* messages(): AsyncGenerator<unknown> {
    for (;;) {
      const m = await pull()
      if (m === END || !running) return
      yield m
    }
  }

  // House replies (grant/decline/transcript) go on the shared category, bigint-encoded.
  const postMessage = async (msg: unknown): Promise<void> => {
    await feed.send(toWire(msg))
  }

  // Per-table co-sign: a board-backed house transport. The `playerT` half is unused on the house
  // side (startHouse only drives `houseT`), so it throws if anyone touches it.
  const makeTransport = (tableId: Hex): { houseT: CoSignTransport; playerT: CoSignTransport } => {
    const t = new MsgBoardTransport(board, cat)
    const houseT = makeBoardHouseCoSign(t, { poll: () => t.poll(), pollMs, timeoutMs })
    const unused = () => { throw new Error(`boardDeps: house playerT is unused for ${tableId}`) }
    const playerT: CoSignTransport = { request: unused, serve: unused }
    return { houseT, playerT }
  }

  const stop = () => {
    running = false
    push(END) // unblock a parked generator so it returns
  }

  return { deps: { messages: messages(), postMessage, makeTransport, getHeadBlock }, stop }
}
