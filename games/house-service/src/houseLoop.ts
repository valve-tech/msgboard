/**
 * houseLoop.ts — pure units that drive the house side of a board-watched table.
 *
 * Security contract (non-negotiable, funds safety):
 *  1. handleOpenRequest builds the house seed chain BLIND: the tip is generated independently of
 *     the request — req only carries `clientSeedCommit`, never a plaintext clientSeed. The house
 *     cannot grind its tip against a known client seed. (line ~45)
 *  2. coSignRound calls verifyReveal(clientSeedCommit, clientSeed) and returns { ok: false }
 *     on mismatch BEFORE invoking runHouseSide, preventing player-grind attacks. (line ~100)
 *  3. The tip is injected via ctx.seedTip in tests (deterministic); production passes `undefined`
 *     and receives a fresh `randomBytes(32)` — mirroring how the codebase injects clocks/seeds. (line ~40)
 */
import { randomBytes } from 'node:crypto'
import type { Hex } from 'viem'
import type { GameDomain, StateSigner, SeedChain, Game } from '@msgboard/games'
import { buildSeedChain, verifyReveal } from '@msgboard/games'
import { runHouseSide, type CoSignTransport } from '@msgboard/games'
import type { OpenTerms } from '@msgboard/settle'
import { reviewOpen } from './openReview'
import type { OpenRequest, Limits } from './openReview'

export type { OpenRequest, Limits }

// ── handleOpenRequest ───────────────────────────────────────────────────────

export interface OpenCtx {
  houseKey: StateSigner & { signMessage(a: { message: { raw: Hex } }): Promise<Hex> }
  domain: GameDomain
  headBlock: bigint
  limits: Limits
  /** The routed game for this open-request's gameId — its maxMultiplierX100 sizes escrow, and the
   *  table's round MUST later co-sign with this SAME game (funds safety). */
  game: Game<unknown>
  /**
   * Injectable house seed tip for test determinism. In production (undefined), a fresh
   * 32-byte random value is generated so the tip is unpredictable and NOT derived from the request.
   *
   * SECURITY: the tip MUST never be derived from request fields. The ctx provides it as an
   * independent secret so the house cannot grind its tip against a known clientSeed.
   */
  seedTip?: Hex
}

/** A signed grant envelope returned by handleOpenRequest. */
export type OpenGrantEnvelope = {
  kind: 'open-grant'
  terms: OpenTerms
  houseSig: Hex
  /**
   * The house's seed chain built blind. Callers (startHouse) persist this so the round step
   * can reveal seeds[1] and tests can assert terms.rngCommit === seedChain.commit.
   */
  seedChain: SeedChain
}

export type OpenDeclineEnvelope = {
  kind: 'open-decline'
  reason: string
}

export type GrantEnvelope = OpenGrantEnvelope | OpenDeclineEnvelope

/**
 * Pure unit: accepts an open-request message off the board, builds the house seed chain BLIND
 * (without reading any plaintext seed from `req`), calls reviewOpen with the house-built rngCommit,
 * and returns a grant or decline envelope.
 *
 * SECURITY (funds): the tip is taken from ctx.seedTip (injected, defaults to randomBytes) — it is
 * NEVER derived from `req`. `req.clientSeedCommit` is stored for round-time verification only.
 */
export async function handleOpenRequest(req: OpenRequest, ctx: OpenCtx): Promise<GrantEnvelope> {
  // SECURITY REQUIREMENT 1: build tip BLIND — independent of req content.
  // Production: fresh unpredictable random bytes. Tests inject a fixed tip for determinism.
  const tip: Hex = ctx.seedTip ?? (`0x${randomBytes(32).toString('hex')}` as Hex)

  // Build house seed chain WITHOUT reading clientSeed (req only has clientSeedCommit).
  const seedChain = buildSeedChain(tip, 1)
  const rngCommit = seedChain.commit // seeds[0]: the published head

  const result = await reviewOpen(req, { ...ctx, rngCommit })
  if (!result.ok) {
    return { kind: 'open-decline', reason: result.reason }
  }

  return {
    kind: 'open-grant',
    terms: result.terms,
    houseSig: result.houseSig,
    seedChain,
  }
}

// ── coSignRound ─────────────────────────────────────────────────────────────

export interface RoundReq {
  /** Plaintext clientSeed revealed by the player at round time. */
  clientSeed: Hex
  /** Stake for this round. */
  stake: bigint
  /** Game params (typed as unknown here; callers supply the concrete TParams). */
  params: unknown
}

export interface RoundCtx<TParams> {
  /** The player's clientSeedCommit stored at open time (keccak256(clientSeed)). */
  clientSeedCommit: Hex
  /** The house seed chain retained from the open grant (seedChain.seeds[1] = serverSeed). */
  seedChain: SeedChain
  /** Session config needed by runHouseSide: table, game, balances, domain, keys.
   *  MUST use the SAME seedTip that was used for the open grant so terms.rngCommit matches. */
  sessionCfg: Parameters<typeof runHouseSide<TParams>>[0]
  /** The transport linking house and player for co-signing. */
  transport: CoSignTransport
}

export type CoSignResult =
  | { ok: true; transcriptJson: string }
  | { ok: false; reason: string }

/**
 * Verifies the player's revealed clientSeed against the stored commit, then drives the full
 * house-side co-sign via runHouseSide, producing a verified transcript.
 *
 * SECURITY REQUIREMENT 2: verifyReveal(clientSeedCommit, clientSeed) is checked FIRST.
 * On mismatch the house refuses and returns { ok: false } — runHouseSide is NEVER called.
 * This closes the player-grind attack where a player tries many clientSeeds against a fixed
 * serverSeed commitment to find a favorable draw.
 *
 * KEY CONSISTENCY: ctx.sessionCfg.seedTip MUST equal the tip used at open time. The
 * runHouseSide call rebuilds buildSeedChain(seedTip, chainLength) so its chain.commit
 * (= rngCommit in the OPEN state) equals the terms.rngCommit the player already co-signed.
 */
export async function coSignRound<TParams>(req: RoundReq, ctx: RoundCtx<TParams>): Promise<CoSignResult> {
  // SECURITY: verify the player's seed reveal against the commit BEFORE anything else.
  if (!verifyReveal(ctx.clientSeedCommit, req.clientSeed)) {
    return { ok: false, reason: 'clientSeed does not match clientSeedCommit — round refused' }
  }

  // Verify seed chain is not exhausted (defensive; buildSeedChain ensures seeds[1] exists for length=1).
  if (!ctx.seedChain.seeds[1]) {
    return { ok: false, reason: 'seed chain exhausted' }
  }

  try {
    const transcriptJson = await runHouseSide(
      ctx.sessionCfg,
      ctx.transport,
      { stake: req.stake, params: req.params as TParams, clientSeed: req.clientSeed },
    )
    return { ok: true, transcriptJson }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── handleRoundRequest (legacy thin wrapper — use coSignRound for real co-signing) ──

/** @deprecated Use coSignRound for real co-signing. Kept for backward compat during migration. */
export interface RoundCtxLegacy {
  clientSeedCommit: Hex
  seedChain: SeedChain
}

/** @deprecated Use coSignRound instead. */
export type RoundResult =
  | { ok: true; serverSeed: Hex }
  | { ok: false; reason: string }

/**
 * @deprecated Replaced by coSignRound (which calls runHouseSide for real co-signing).
 * Left in place so existing callers that only need the verify gate compile without changes.
 */
export async function handleRoundRequest(req: { clientSeed: Hex }, ctx: RoundCtxLegacy): Promise<RoundResult> {
  if (!verifyReveal(ctx.clientSeedCommit, req.clientSeed)) {
    return { ok: false, reason: 'clientSeed does not match clientSeedCommit — round refused' }
  }
  const serverSeed = ctx.seedChain.seeds[1]
  if (!serverSeed) {
    return { ok: false, reason: 'seed chain exhausted' }
  }
  return { ok: true, serverSeed }
}

// ── startHouse ──────────────────────────────────────────────────────────────

export interface HouseCfg {
  boardRpc: string
  chainId: number
  houseChannel: Hex
  houseKey: OpenCtx['houseKey']
  limits: Limits
  /** EIP-712 domain for session state co-signing. */
  domain: GameDomain
  /**
   * The registry of hosted games. Each open-request is routed to the game whose `gameId` matches
   * `req.gameId`; the table's later round MUST co-sign with the SAME game it opened under (funds
   * safety — a mismatched game would compute the wrong outcome/payout). startHouse keys these into a
   * `Map<number, Game<unknown>>` by `game.gameId`.
   */
  games: Game<unknown>[]
  /** Session settlement mode (0 = optimistic). */
  settlementMode?: number
  /**
   * Injectable seed tip for test determinism. In production (undefined), each open request
   * generates a fresh randomBytes(32) tip. Tests inject a fixed tip so the rngCommit is
   * predictable and the verifyCtx.commit can be precomputed.
   */
  seedTip?: Hex
}

/**
 * Per-table state persisted between open and round steps.
 * The tip MUST be the same between open and round so runHouseSide rebuilds the
 * same seed chain (and therefore the same rngCommit) that was signed at open time.
 */
interface TableState {
  clientSeedCommit: Hex
  seedChain: SeedChain
  /**
   * The gameId the table OPENED under. The round resolves the registry by THIS id and co-signs with
   * the same game — funds-safety-critical: opening under one game and settling under another would
   * mis-compute the outcome/payout.
   */
  gameId: number
  /** The SAME tip used at open-time (stored so coSignRound's sessionCfg.seedTip matches). */
  seedTip: Hex
  /**
   * Per-table escrow from the signed OpenTerms. The round MUST co-sign nonce-0 balances equal to
   * these on-chain escrow amounts, or the off-chain refund floor diverges from disputeFromOpen's
   * on-chain floor (a funds-safety break). Escrow is sized per stake/odds, so it is per-table —
   * never a fixed config default.
   */
  escrowPlayer: bigint
  escrowHouse: bigint
}

export interface HouseDeps {
  /**
   * Async iterator / feed of inbound board messages. Each yielded value is a raw message object.
   * In tests, supply an async generator; in production, wrap a polled MsgBoardTransport.
   */
  messages: AsyncIterable<unknown>
  /**
   * Post a message to the board (grant, transcript, etc.).
   */
  postMessage(msg: unknown): Promise<void>
  /**
   * Factory: given the tableId, return a linked {houseT, playerT} CoSignTransport pair.
   * In tests, return a memoryCoSignPair(); in production, build MsgBoard-backed transports.
   */
  makeTransport(tableId: Hex): { houseT: CoSignTransport; playerT: CoSignTransport }
  /**
   * Return the current chain head block number for computing grant expiry.
   * Called once per open-request so expiry is always fresh.
   */
  getHeadBlock(): Promise<bigint>
}

/**
 * Wiring function: drives the house side of a board-watched table.
 * Handles open-request and round-request messages, calling the pure units
 * handleOpenRequest / coSignRound for each. Uses INJECTABLE deps so unit tests
 * can run without a live board.
 *
 * Design principles:
 *  - Each message is handled in its OWN try/catch: one malformed message cannot crash the watcher.
 *  - stop() actually halts the loop (sets a flag checked between every iteration).
 *  - Deps are supplied by the caller; production creates real board clients, tests inject fakes.
 */
export function startHouse(cfg: HouseCfg, deps: HouseDeps): { stop(): void } {
  let running = true
  const stop = () => { running = false }

  // Per-table state: keyed by tableId (lowercase hex).
  const tables = new Map<Hex, TableState>()
  // Per-table CoSignTransport pairs: keyed by tableId.
  const transports = new Map<Hex, { houseT: CoSignTransport; playerT: CoSignTransport }>()
  // Game registry keyed by gameId. An open-request resolves its game here; the table's round
  // re-resolves the SAME gameId so it co-signs under the game it opened with (funds safety).
  const registry = new Map<number, Game<unknown>>(cfg.games.map((g) => [g.gameId, g]))

  const loop = async () => {
    for await (const raw of deps.messages) {
      if (!running) break
      try {
        const msg = raw as Record<string, unknown>
        const kind = msg['kind']

        if (kind === 'open-request') {
          // ── open-request ────────────────────────────────────────────
          try {
            const req = msg as unknown as OpenRequest
            // Route by gameId. An unknown game is declined here — we never call handleOpenRequest
            // (and thus never size escrow) for a game we cannot also co-sign the round under.
            const game = registry.get(req.gameId)
            if (!game) {
              await deps.postMessage({ kind: 'open-decline', tableId: req.tableId, reason: 'unknown gameId' })
              continue
            }
            const headBlock = await deps.getHeadBlock()
            const grant = await handleOpenRequest(req, {
              houseKey: cfg.houseKey,
              domain: cfg.domain,
              headBlock,
              limits: cfg.limits,
              game,
              // Production: undefined → fresh randomBytes per request. Tests inject a fixed tip.
              seedTip: cfg.seedTip,
            })

            if (grant.kind === 'open-grant') {
              // Persist the tip, clientSeedCommit, and per-table escrow for the round step.
              const tableId = req.tableId.toLowerCase() as Hex
              tables.set(tableId, {
                clientSeedCommit: req.clientSeedCommit,
                seedChain: grant.seedChain,
                // The game the table opened under — re-resolved at round time so the round co-signs
                // with the SAME game (funds safety).
                gameId: req.gameId,
                // The tip: either the production random one or re-derived from seedChain.
                // We use seeds[chainLength] === tip (seeds[1] for length=1) as the stored tip,
                // because handleOpenRequest may have generated it via randomBytes internally.
                // However, since handleOpenRequest does NOT expose the tip it used, we must
                // re-read it from the seedChain: seeds[seeds.length - 1] is the raw tip.
                seedTip: grant.seedChain.seeds[grant.seedChain.seeds.length - 1] as Hex,
                // Carry the signed escrow so the round co-signs a nonce-0 floor equal to the
                // on-chain escrow (refund-floor consistency — see TableState).
                escrowPlayer: grant.terms.escrowPlayer,
                escrowHouse: grant.terms.escrowHouse,
              })
              if (!transports.has(tableId)) {
                transports.set(tableId, deps.makeTransport(req.tableId))
              }
            }

            // SECURITY (funds): post ONLY {terms, houseSig} (or the decline reason) — NEVER the seed
            // chain. Revealing the server seed before the player reveals its clientSeed would let the
            // player grind clientSeed against a known serverSeed to bias the roll. The server seed
            // surfaces only inside the co-signed ROUND envelope, after rngCommit is fixed on-chain.
            const posted = grant.kind === 'open-grant'
              ? { kind: 'open-grant' as const, tableId: req.tableId, terms: grant.terms, houseSig: grant.houseSig }
              : { kind: 'open-decline' as const, tableId: req.tableId, reason: grant.reason }
            await deps.postMessage(posted)
          } catch (err) {
            console.error('[house] open-request error:', err)
          }

        } else if (kind === 'round-request') {
          // ── round-request ───────────────────────────────────────────
          try {
            // stake arrives as a bigint over the board (fromWire-restored) or a string from an
            // in-memory feed; BigInt(...) below normalizes both. params is fromWire-restored too.
            const roundMsg = msg as {
              tableId: Hex; clientSeed: Hex; stake: bigint | string; params: unknown
              playerAddress: Hex; playerKey: Hex
            }
            const tableId = roundMsg.tableId.toLowerCase() as Hex
            const state = tables.get(tableId)
            if (!state) {
              await deps.postMessage({ kind: 'round-decline', tableId: roundMsg.tableId, reason: 'no open grant for table' })
              continue
            }
            const transportPair = transports.get(tableId)
            if (!transportPair) {
              await deps.postMessage({ kind: 'round-decline', tableId: roundMsg.tableId, reason: 'no transport for table' })
              continue
            }
            // FUNDS-SAFETY-CRITICAL: re-resolve the game the table OPENED under. The round MUST
            // co-sign with the SAME game (its outcome/encoding/escrow), or the payout diverges from
            // the signed OpenTerms. If the registry no longer has it, decline rather than co-sign blind.
            const game = registry.get(state.gameId)
            if (!game) {
              await deps.postMessage({ kind: 'round-decline', tableId: roundMsg.tableId, reason: 'unknown gameId for open table' })
              continue
            }

            const sessionCfg: Parameters<typeof runHouseSide<unknown>>[0] = {
              domain: cfg.domain,
              tableId: roundMsg.tableId,
              game,
              // In the transport-backed flow the player signs over the CoSignTransport, not locally.
              // runHouseSide only reads player.address (for co-sig verification); it never calls
              // player.signTypedData or player.signMessage directly — those go over the transport.
              player: {
                address: roundMsg.playerKey,
                signTypedData: async () => { throw new Error('player signs over transport') },
                signMessage: async () => { throw new Error('player signs over transport') },
              },
              house: cfg.houseKey as Parameters<typeof runHouseSide<unknown>>[0]['house'],
              seedTip: state.seedTip,
              chainLength: 1,
              // SECURITY: per-table escrow from the signed OpenTerms (stored at open) — NOT a fixed
              // config default — so the co-signed nonce-0 floor equals the on-chain escrow.
              openBalances: { player: state.escrowPlayer, house: state.escrowHouse },
              settlementMode: cfg.settlementMode ?? 0,
            }

            const result = await coSignRound(
              { clientSeed: roundMsg.clientSeed, stake: BigInt(roundMsg.stake), params: roundMsg.params },
              { clientSeedCommit: state.clientSeedCommit, seedChain: state.seedChain, sessionCfg, transport: transportPair.houseT },
            )

            if (result.ok) {
              // Post the transcript BEFORE discarding state: if postMessage throws, the table stays
              // open so the player can retry and the house keeps its audit trail. (The player is also
              // protected — it captured the co-signed final state via onAccept — but the house must
              // not silently lose the transcript it just co-signed.)
              await deps.postMessage({ kind: 'round-transcript', tableId: roundMsg.tableId, transcriptJson: result.transcriptJson })
              tables.delete(tableId)
              transports.delete(tableId) // drop the per-table co-sign transport reference (one roll per table)
            } else {
              await deps.postMessage({ kind: 'round-decline', tableId: roundMsg.tableId, reason: result.reason })
            }
          } catch (err) {
            console.error('[house] round-request error:', err)
          }
        }
        // Unknown message kinds are silently ignored (future-proofing).
      } catch (err) {
        // Outer catch: malformed message that couldn't even be read as an object.
        console.error('[house] message dispatch error:', err)
      }
    }
  }

  void loop()
  return { stop }
}
