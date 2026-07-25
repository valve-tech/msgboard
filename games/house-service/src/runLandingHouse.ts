/**
 * runLandingHouse.ts — the run config for the msgboard.xyz LANDING coin-flip house bot.
 *
 * This is the zero-stakes, provably-fair coin flip the landing "Arcade" tab plays against a house bot,
 * run over the REAL board-mediated commit-reveal protocol at 0 tokens at risk (see the design spec:
 * docs/superpowers/specs/2026-07-25-provably-fair-coinflip-vs-house-bot-design.md). It differs from the
 * production arcade house (`runBoardHouse` defaults) in exactly three ways:
 *
 *   - `games: [coinflip]`            — it serves ONLY the fair 2× coin flip (gameId 5), nothing else.
 *   - `settlementMode: 0` (optimistic) — nothing ever settles on-chain. No HouseChannel call, no escrow,
 *                                        no `settleWithSeeds`; the co-signed transcript IS the product.
 *   - `category: landingHouseCategory` — an isolated board feed so landing traffic never mixes with the
 *                                        real-money arcade's `houseCategory`.
 *
 * The house key only ever SIGNS (EIP-712 co-sign + PoW board posts); it needs no funds. The EIP-712
 * domain `verifyingContract` is the already-deployed 943 HouseChannel (`DEPLOYMENT_943.houseChannel`) —
 * it is never called on-chain in optimistic mode, it just anchors the signing domain both sides share.
 */
import { type Hex } from 'viem'
import { coinflip, type Game } from '@msgboard/games'
import { landingHouseCategory } from '@msgboard/settle'
import { runBoardHouse, type HouseSigner, type RunHouseOpts } from './runHouse'
import { DEPLOYMENT_943, DEFAULT_LIMITS } from './liveConfig'
import type { Limits } from './openReview'

export interface LandingHouseOpts {
  /** The house signing key (mnemonic index 1) — signs only, needs no funds. */
  houseSigner: HouseSigner
  /** Chain id. Defaults to the 943 deployment. */
  chainId?: number
  /** Chain-read RPC (head block). Defaults to the 943 deployment. */
  rpcUrl?: string
  /** MsgBoard RPC. Defaults to the 943 deployment. */
  boardRpc?: string
  /**
   * EIP-712 domain `verifyingContract`. Defaults to the deployed 943 HouseChannel — never called in
   * optimistic mode, only anchors the shared signing domain.
   */
  houseChannel?: Hex
  /** Open-review limits. Defaults to DEFAULT_LIMITS (escrow is 0-relevant at zero stakes). */
  limits?: Limits
  pollMs?: number
  timeoutMs?: number
}

/**
 * Build the `RunHouseOpts` for the landing coin-flip house: coinflip-only, optimistic (mode 0), on the
 * isolated landing category. Pure — returned so the entrypoint AND tests consume the identical config.
 */
export function landingHouseConfig(opts: LandingHouseOpts): RunHouseOpts {
  const chainId = opts.chainId ?? DEPLOYMENT_943.chainId
  return {
    rpcUrl: opts.rpcUrl ?? DEPLOYMENT_943.rpcUrl,
    boardRpc: opts.boardRpc ?? DEPLOYMENT_943.boardRpc,
    chainId,
    houseChannel: opts.houseChannel ?? DEPLOYMENT_943.houseChannel,
    houseSigner: opts.houseSigner,
    limits: opts.limits ?? DEFAULT_LIMITS,
    games: [coinflip] as Game<unknown>[],
    category: landingHouseCategory(chainId),
    settlementMode: 0,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  }
}

/**
 * Start the landing coin-flip house against live infrastructure. Returns `{ stop }` to halt the loop.
 * Deployable as a long-running process (see `scripts/run-landing-house.ts`); actual deploy is via the
 * ansible runbook, out of code scope.
 */
export function runLandingHouse(opts: LandingHouseOpts): { stop(): void } {
  return runBoardHouse(landingHouseConfig(opts))
}
