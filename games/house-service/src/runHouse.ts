/**
 * runHouse.ts — wire the board-watching house loop to REAL 943 infrastructure.
 *
 * This is the one place that turns the pure units (startHouse + makeBoardHouseDeps) into a running
 * house against a live MsgBoard + chain: a PoW-stamping board client (createBoardClient, which uses
 * the native→WASM→JS stamper cascade), a viem public client for the head block, and the house
 * signing key. The house is purely off-chain in the happy path — it co-signs session state and posts
 * PoW board messages; it never sends an on-chain tx (open/settle are the player's calls).
 *
 * Used by `main.ts` (the long-running deployable process) and by the `live-round` proof script.
 */
import { createPublicClient, http, type Hex } from 'viem'
import { createBoardClient, makeDomain, dice, limbo, plinko, keno, type Game, type StateSigner } from '@msgboard/games'
import { startHouse } from './houseLoop'
import { makeBoardHouseDeps } from './boardDeps'
import type { Limits } from './openReview'

/** A house signer: EIP-712 typed-data + personal-message signing, plus its address. */
export type HouseSigner = StateSigner & { signMessage(a: { message: { raw: Hex } }): Promise<Hex> }

export interface RunHouseOpts {
  /** JSON-RPC URL for chain reads (head block). */
  rpcUrl: string
  /** MsgBoard RPC URL (the `msgboard_` module endpoint) for posting/reading board messages. */
  boardRpc: string
  chainId: number
  houseChannel: Hex
  /** The house signing key (mnemonic index 1 in our deployment) — never the owner key. */
  houseSigner: HouseSigner
  /** Open-review limits (escrow cap, min odds, clock + expiry windows). */
  limits: Limits
  /** The hosted games registry, routed by gameId. Defaults to the four single-outcome games. */
  games?: Game<unknown>[]
  /** Poll cadence + co-sign timeout (ms). Production defaults (1000 / 120000) if omitted. */
  pollMs?: number
  timeoutMs?: number
}

/**
 * Start the house against live infrastructure. Returns `{ stop }` which halts the board feed loop
 * and the house message loop. Safe to call in Node (the board client's main-thread guard passes
 * because Node has no `document`).
 */
export function runBoardHouse(opts: RunHouseOpts): { stop(): void } {
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) })
  const board = createBoardClient(opts.boardRpc)
  const domain = makeDomain(opts.chainId, opts.houseChannel)

  const { deps, stop: stopDeps } = makeBoardHouseDeps({
    board,
    chainId: opts.chainId,
    // The contract's open() checks `block.timestamp > terms.expiry`, so terms.expiry is a Unix
    // TIMESTAMP. reviewOpen computes expiry = head + limits.expiryBlocks, so "head" must be the head
    // block's TIMESTAMP and limits.expiryBlocks is a seconds window — NOT a block number/count.
    // (The `getHeadBlock` / `expiryBlocks` names are a carryover misnomer; see DEFAULT_LIMITS.)
    getHeadBlock: async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  })

  const house = startHouse(
    {
      boardRpc: opts.boardRpc,
      chainId: opts.chainId,
      houseChannel: opts.houseChannel,
      houseKey: opts.houseSigner,
      limits: opts.limits,
      domain,
      games: opts.games ?? ([dice, limbo, plinko, keno] as Game<unknown>[]),
      settlementMode: 1,
    },
    deps,
  )

  return {
    stop() {
      house.stop()
      stopDeps()
    },
  }
}
