import { createPublicClient, http, stringToHex, type Hex } from 'viem'
import { MsgBoardClient, categoryHash } from '@msgboard/sdk'
import type { BoardClient } from './msgboardTransport'
import { loadDefaultStamper } from './stamper'

/**
 * Bridges a real `@msgboard/sdk` MsgBoardClient to the `BoardClient` surface `MsgBoardTransport`
 * needs. The only gap is proof-of-work: the transport hands us `{ category, data }`, and the board
 * requires a PoW-stamped message — so `addMessage` grinds the work (against the board's live
 * difficulty, read by `doPoW`) and submits, while `content` passes straight through (the SDK's
 * `RPCMessage` already exposes `data`, which is the hex the transport reads back).
 *
 * On a testnet board (943, default difficulty factors) a small message grinds in well under a
 * second, so this is usable for both the headless bots and best-effort browser broadcast. On a
 * production-difficulty board, run `doPoW` off the UI thread (a Web Worker) — see the SDK README.
 */
/**
 * GUARD: proof-of-work (`doPoW`) is a multi-second busy-grind. Running it on a browser's MAIN thread
 * freezes the tab (it's the thread that renders the UI) for the whole grind — never do this. We detect
 * the UI main thread by the presence of `document` (a Web Worker has no `document`; Node has none
 * either), and throw LOUDLY rather than silently hang the page. To post from a browser, grind inside a
 * Web Worker (`new Worker(...)`) and call this there. This is enforced here, at the single PoW
 * chokepoint, so no caller — or future agent — can reintroduce the freeze by accident.
 */
function assertOffMainThread(): void {
  if (typeof document !== 'undefined') {
    throw new Error(
      'MsgBoard proof-of-work (doPoW) must not run on the browser main thread — it freezes the UI for ' +
        'the whole grind. Run the board client inside a Web Worker instead. (msgboard-games/board.ts guard)',
    )
  }
}

export function msgBoardClientAdapter(board: MsgBoardClient, opts?: { stamp?: Stamper }): BoardClient {
  // Resolve the default stamper cascade (native → WASM) ONCE, lazily, and reuse it across messages.
  // `undefined` until first probed; `null` once probed if no native/WASM engine is available.
  let defaultStamper: Stamper | null | undefined
  return {
    async addMessage(seed: { category: Hex; data: Hex }) {
      assertOffMainThread()
      // Pick a stamper: an explicitly injected one, else the cached default cascade (native → WASM).
      const stamp = opts?.stamp ?? (defaultStamper ??= await loadDefaultStamper())
      if (stamp) {
        try {
          // Post-style path (mirrors `post()` below): read the board's live difficulty + head block,
          // mint the PoW stamp with the fast engine, and submit the full message. The node recomputes
          // the hash, so only the nonce travels on the wire.
          const status = await board.status()
          const { hash: blockHash } = await board.lastestBlock()
          const workMultiplier = BigInt(status.workMultiplier)
          const workDivisor = BigInt(status.workDivisor)
          const { nonce } = await stamp({
            category: seed.category,
            data: seed.data,
            workMultiplier,
            workDivisor,
            blockHash,
          })
          return await board.addMessage({
            version: 1,
            blockHash,
            category: seed.category,
            data: seed.data,
            nonce,
            workMultiplier,
            workDivisor,
          })
        } catch {
          // Any failure in the fast path (engine exhausted maxIters, status/block read failed, etc.)
          // falls through to the JS grind below — never drop the message.
        }
      }
      // JS FALLBACK: the SDK's own `doPoW` grind (used when no fast stamper loaded or the fast path threw).
      const work = await board.doPoW(seed.category, seed.data)
      return board.addMessage(work.message)
    },
    async content(filter: { category?: Hex }) {
      const out = await board.content(filter.category ? { category: filter.category } : {})
      // SDK Content is Record<categoryHash, RPCMessage[]>; RPCMessage has `data: Hex` → structurally
      // the Record<string, {data: Hex}[]> the transport expects.
      return out as unknown as Record<string, Array<{ data: Hex }>>
    },
  }
}

/** The raw SDK `MsgBoardClient` for an RPC whose node runs the `msgboard_` module (e.g. a valve.city
 *  endpoint: https://one.valve.city/rpc/<key>/evm/<chainId>). Used by `post` for status/block/submit. */
export function createMsgBoardClient(rpcUrl: string): MsgBoardClient {
  const viemClient = createPublicClient({ transport: http(rpcUrl) })
  // viem's `request` is typed to a fixed RPC schema; the board needs the SDK's looser
  // `{ method: string; params }` Provider. Forward through a thin wrapper (the msgboard_* methods
  // aren't in viem's schema anyway — the transport just relays them).
  const provider = {
    request: <T, U extends unknown[]>(arg: { method: string; params: U }): Promise<T> =>
      viemClient.request(arg as never) as Promise<T>,
  }
  return new MsgBoardClient(provider)
}

/** Build a live `BoardClient` from an RPC URL. The returned client posts real PoW-stamped notices
 *  (JS grind) and reads the live board — used by `MsgBoardTransport` (e.g. the read-only live feed). */
export function createBoardClient(rpcUrl: string): BoardClient {
  return msgBoardClientAdapter(createMsgBoardClient(rpcUrl))
}

// ── unified post API (SDK-friendly verbs: `stamp` + `post`) ─────────────────────────────────────
// The crypto step — minting the proof-of-work "stamp" for a message (what the SDK calls `doPoW`) — is
// the slow part and the part that must run OFF the UI/main thread. We model it as a pluggable
// `Stamper` so the heavy grind lives wherever it should: a native Rust addon in the bots, a WASM
// module in the browser worker, or the SDK's JS grind as a fallback. The thin RPC bits (read the
// board's difficulty + head block, then submit) stay on the calling thread.

/** Inputs a stamper needs to mint a PoW stamp for one message. */
export type StampInput = {
  category: Hex
  data: Hex
  workMultiplier: bigint
  workDivisor: bigint
  blockHash: Hex
}
/** The minted stamp: the PoW nonce (and its hash, for reference). */
export type Stamp = { nonce: bigint; hash: Hex }
/** Mints a PoW stamp for a message. Pure compute — given no key and no network. */
export type Stamper = (input: StampInput) => Promise<Stamp> | Stamp

/**
 * Stamp a notice and submit it to the board under `categoryName` — the one-call unification of
 * `doPoW` + `addMessage`. Reads the board's live difficulty + head block, hands the message to the
 * injected `stamp` engine (native/WASM/JS — that's the only heavy part), then submits. The node
 * recomputes the hash, so only the nonce is needed on the wire (see toRLP).
 */
export async function post({
  board,
  category: categoryName,
  notice,
  stamp,
}: {
  board: MsgBoardClient
  /** the category NAME (hashed here), e.g. `games.msgboard.xyz:lobby:943`. */
  category: string
  notice: unknown
  stamp: Stamper
}): Promise<Hex> {
  const status = await board.status()
  const { hash: blockHash } = await board.lastestBlock()
  const category = categoryHash(categoryName)
  const data = stringToHex(JSON.stringify(notice))
  const workMultiplier = BigInt(status.workMultiplier)
  const workDivisor = BigInt(status.workDivisor)
  const { nonce } = await stamp({ category, data, workMultiplier, workDivisor, blockHash })
  return (await board.addMessage({
    version: 1,
    blockHash,
    category,
    data,
    nonce,
    workMultiplier,
    workDivisor,
  })) as Hex
}
