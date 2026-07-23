import { concatHex, encodeAbiParameters, keccak256, numberToHex, stringToHex, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS } from '../game'

/**
 * MINES — the only STATEFUL game in the roster.
 *
 * Unlike dice/limbo/plinko/keno (single-draw `Game<TParams>`), Mines is a multi-step,
 * co-signed session game in the spirit of hilo-war: a board is committed up-front (hidden
 * layout), the player reveals tiles one at a time (each a co-signed step), and either cashes
 * out the running multiplier or busts on a mine. The honest running multiplier is fully
 * determined by the board shape (no external paytable):
 *
 *   after revealing k SAFE tiles of an (N total, M mines) board (S = N - M safe):
 *     fairMultiplier(k) = Π_{i=0..k-1} (N - i) / (S - i)   ==  C(N,k) / C(S,k)
 *   then the 1% house edge is applied:  edged = fair * (1 - edge).
 *
 * This module is pure / deterministic / parity-testable the way hilo-war's `rules.ts` is.
 * It owns the preimage of `SessionState.gameStateHash`; the session layer co-signs each step.
 *
 * gameId = 5 (dice=1, limbo=2, plinko=3, keno=4 → mines=5).
 */

export const GAME_ID = 5 as const

// (1 - edge) expressed in hundredths: (10000 - 100)/100 == 99  (i.e. 0.99x == 99). Mirrors keno.
const ONE_MINUS_EDGE_X100 = (10_000n - EDGE_BPS) / HUNDREDTHS // 99n

/** Board sizing bounds. Defaults mirror the common 5x5 grid; reference (IMG_2259.MP4) grid/mine
 *  options are UNCONFIRMED — see report. These bounds are deliberately permissive so a tuned
 *  config can be dropped in without code changes. */
export const DEFAULT_TILES = 25 // 5x5
export const MIN_TILES = 2
export const MAX_TILES = 256 // keep tileIndex in uint8 range for the on-chain mirror

export interface MinesConfig {
  /** total tiles on the board, N. */
  tiles: number
  /** number of mines, M. Must satisfy 1 <= M <= N-1 (at least one safe and one mine). */
  mines: number
}

/** A concrete hidden board: the set of mined tile indices plus the blinding salt. The commitment
 *  is hash(layout, salt); the layout stays secret until cash-out reveal or dispute. */
export interface MinesBoard {
  config: MinesConfig
  /** mined tile indices in [0, tiles). Length === config.mines, strictly sorted, distinct. */
  mineTiles: number[]
  /** 32-byte blinding salt. */
  salt: Hex
}

export enum MinesPhase {
  /** board committed, no reveals yet — playable. */
  PLAYING = 0,
  /** player cashed out before hitting a mine — terminal win. */
  CASHED_OUT = 1,
  /** player revealed a mine — terminal loss. */
  BUSTED = 2,
}

/** Co-signed running state of one Mines session. Field order is consensus: the Solidity mirror
 *  (MinesRules.sol) MUST match `GAME_STATE_ABI` below exactly. Hidden layout is NOT in the state —
 *  only the commitment is, so each co-signed step keeps the board secret. */
export interface MinesState {
  phase: MinesPhase
  config: MinesConfig
  /** commitment = hashBoard(board); binds the hidden layout. */
  commit: Hex
  /** tiles revealed so far, in reveal order; all safe while phase === PLAYING. */
  revealed: number[]
  /** running multiplier in hundredths AFTER the house edge (100 == 1.00x). 100 at k=0. */
  multiplierX100: bigint
  /** the mine tile that busted the session, or null. Only set in BUSTED. */
  bustTile: number | null
}

export type MinesMove =
  | { kind: 'REVEAL'; tile: number }
  | { kind: 'CASH_OUT' }

export type MinesResult = { state: MinesState } | { error: string }

// ---------------------------------------------------------------------------
// commitment
// ---------------------------------------------------------------------------

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

/** Canonical board commitment: keccak256(domain ‖ tiles ‖ mines ‖ mineTiles[] ‖ salt).
 *  Deterministic and dependency-light; mirrors hilo-war's `hashBetCommit` style. */
export function hashBoard(board: MinesBoard): Hex {
  validateBoard(board)
  const tilesHex = board.mineTiles.map((t) => numberToHex(t, { size: 2 })) // uint16 per tile
  return keccak256(
    concatHex([
      stringToHex('mines/board/v1/'),
      numberToHex(board.config.tiles, { size: 2 }),
      numberToHex(board.config.mines, { size: 2 }),
      ...tilesHex,
      board.salt,
    ]),
  )
}

// ---------------------------------------------------------------------------
// fixed-point multiplier
// ---------------------------------------------------------------------------

/** Apply the 1% house edge to a "fair" multiplier in hundredths. Mirrors keno's edge helper
 *  (exported under a mines-specific name to avoid a barrel-export collision with keno). */
export function applyMinesEdgeX100(fairX100: bigint): bigint {
  return (fairX100 * ONE_MINUS_EDGE_X100) / HUNDREDTHS
}

/**
 * Fair multiplier in hundredths after revealing `safeRevealed` safe tiles of an (N tiles, M mines)
 * board, BEFORE the edge:  fair = Π (N-i)/(S-i), computed as one rational division of bigints to
 * avoid compounding rounding (numerator = Π (N-i), denominator = Π (S-i)).
 */
export function fairMultiplierX100(config: MinesConfig, safeRevealed: number): bigint {
  validateConfig(config)
  const safe = config.tiles - config.mines
  if (safeRevealed < 0 || safeRevealed > safe) throw new Error('mines: safeRevealed out of range')
  let num = 1n
  let den = 1n
  for (let i = 0; i < safeRevealed; i++) {
    num *= BigInt(config.tiles - i)
    den *= BigInt(safe - i)
  }
  return (num * HUNDREDTHS) / den
}

/** Running (edged) multiplier in hundredths after `safeRevealed` safe reveals. 100 (1.00x) at k=0. */
export function multiplierX100At(config: MinesConfig, safeRevealed: number): bigint {
  return applyMinesEdgeX100(fairMultiplierX100(config, safeRevealed))
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export function validateConfig(config: MinesConfig): void {
  const { tiles, mines } = config
  if (!Number.isInteger(tiles) || tiles < MIN_TILES || tiles > MAX_TILES) {
    throw new Error(`mines: tiles out of range [${MIN_TILES},${MAX_TILES}]`)
  }
  if (!Number.isInteger(mines) || mines < 1 || mines > tiles - 1) {
    throw new Error('mines: mines out of range [1, tiles-1]')
  }
}

function validateBoard(board: MinesBoard): void {
  validateConfig(board.config)
  const { tiles, mines } = board.config
  if (board.mineTiles.length !== mines) throw new Error('mines: mineTiles length != mines')
  let prev = -1
  const seen = new Set<number>()
  for (const t of board.mineTiles) {
    if (!Number.isInteger(t) || t < 0 || t >= tiles) throw new Error('mines: mine tile out of range')
    if (seen.has(t)) throw new Error('mines: duplicate mine tile')
    if (t <= prev) throw new Error('mines: mineTiles must be strictly sorted ascending')
    seen.add(t)
    prev = t
  }
  if (typeof board.salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(board.salt)) {
    throw new Error('mines: salt must be a 32-byte hex string')
  }
}

// ---------------------------------------------------------------------------
// pure transitions
// ---------------------------------------------------------------------------

/** Start a session from a committed board. The layout stays hidden — only `commit` is carried. */
export function start(config: MinesConfig, commit: Hex): MinesState {
  validateConfig(config)
  return {
    phase: MinesPhase.PLAYING,
    config,
    commit,
    revealed: [],
    multiplierX100: HUNDREDTHS, // 1.00x at k=0
    bustTile: null,
  }
}

/**
 * Reveal a tile. The transition is "outcome-bearing": the caller (session layer, holding the
 * board) supplies whether the tile is a mine via `isMine`. This keeps `reveal` pure and the
 * hidden layout out of `MinesState`, exactly as hilo-war supplies unmasked card indices to
 * `SHOWDOWN`. On a safe reveal the running multiplier advances; on a mine the session busts.
 */
export function reveal(s: MinesState, tile: number, isMine: boolean): MinesResult {
  const err = (e: string): MinesResult => ({ error: `mines: ${e}` })
  if (s.phase !== MinesPhase.PLAYING) return err(`REVEAL in terminal phase ${s.phase}`)
  if (!Number.isInteger(tile) || tile < 0 || tile >= s.config.tiles) return err('reveal tile out of range')
  if (s.revealed.includes(tile)) return err('tile already revealed')

  if (isMine) {
    return { state: { ...s, phase: MinesPhase.BUSTED, bustTile: tile, multiplierX100: 0n } }
  }
  const revealed = [...s.revealed, tile]
  const safe = s.config.tiles - s.config.mines
  if (revealed.length > safe) return err('more safe reveals than safe tiles')
  return {
    state: {
      ...s,
      revealed,
      multiplierX100: multiplierX100At(s.config, revealed.length),
    },
  }
}

/** Cash out the running multiplier. Only valid while PLAYING with at least one safe reveal. */
export function cashOut(s: MinesState): MinesResult {
  const err = (e: string): MinesResult => ({ error: `mines: ${e}` })
  if (s.phase !== MinesPhase.PLAYING) return err(`CASH_OUT in terminal phase ${s.phase}`)
  if (s.revealed.length === 0) return err('cannot cash out before any reveal')
  return { state: { ...s, phase: MinesPhase.CASHED_OUT } }
}

/** Convenience dispatcher mirroring hilo-war's `applyMove`. REVEAL needs the board to resolve
 *  mine-ness, so it is routed through `reveal` with a membership check against the board. */
export function applyMove(s: MinesState, m: MinesMove, board?: MinesBoard): MinesResult {
  switch (m.kind) {
    case 'REVEAL': {
      if (!board) return { error: 'mines: REVEAL requires the board to resolve the tile' }
      if (hashBoard(board) !== s.commit) return { error: 'mines: board does not match commitment' }
      return reveal(s, m.tile, board.mineTiles.includes(m.tile))
    }
    case 'CASH_OUT':
      return cashOut(s)
  }
}

// ---------------------------------------------------------------------------
// settlement helpers
// ---------------------------------------------------------------------------

/** Signed player delta in chip base units for a terminal state, given a stake.
 *  CASHED_OUT: stake*(mult-1) > 0. BUSTED: -stake. PLAYING: 0 (not yet settled). */
export function playerDelta(s: MinesState, stake: bigint): bigint {
  switch (s.phase) {
    case MinesPhase.CASHED_OUT:
      return (stake * s.multiplierX100) / HUNDREDTHS - stake
    case MinesPhase.BUSTED:
      return -stake
    default:
      return 0n
  }
}

// ---------------------------------------------------------------------------
// dispute / verify (adjudication)
// ---------------------------------------------------------------------------

export interface MinesClaim {
  config: MinesConfig
  commit: Hex
  /** the ordered reveal sequence the player claims to have made. */
  reveals: number[]
  /** whether the player claims to have cashed out (true) or busted (false). */
  cashedOut: boolean
  /** the running multiplier (hundredths, edged) the player claims at settlement. */
  claimedMultiplierX100: bigint
}

export interface MinesVerdict {
  ok: boolean
  reason?: string
  /** the honest terminal state recomputed from the revealed board, when ok. */
  state?: MinesState
}

/**
 * Adjudicate a disputed Mines session: the loser of the dispute reveals (board, salt); we recheck
 * the commitment, replay the claimed reveal sequence against the real layout, and confirm the
 * claimed multiplier/terminal phase. Rejects: commitment mismatch, out-of-range/duplicate reveals,
 * a mine claimed as safe (or replaying past a bust), an inflated multiplier, or a cash-out claim
 * that contradicts the replay.
 */
export function verify(claim: MinesClaim, board: MinesBoard): MinesVerdict {
  // 1) the revealed board must match the committed config + commitment.
  if (board.config.tiles !== claim.config.tiles || board.config.mines !== claim.config.mines) {
    return { ok: false, reason: 'board config does not match claim' }
  }
  let commit: Hex
  try {
    commit = hashBoard(board)
  } catch (e) {
    return { ok: false, reason: `invalid board: ${(e as Error).message}` }
  }
  if (commit !== claim.commit) return { ok: false, reason: 'board does not match commitment' }

  const mineSet = new Set(board.mineTiles)

  // 2) replay the reveal sequence through the pure transitions.
  let s = start(claim.config, claim.commit)
  for (const tile of claim.reveals) {
    const res = reveal(s, tile, mineSet.has(tile))
    if ('error' in res) return { ok: false, reason: res.error }
    s = res.state
    if (s.phase === MinesPhase.BUSTED) break
  }

  // 3) reconcile the claimed terminal phase with the replay.
  const hitMine = s.phase === MinesPhase.BUSTED
  if (claim.cashedOut) {
    if (hitMine) return { ok: false, reason: 'claimed cash-out but a revealed tile was a mine' }
    const res = cashOut(s)
    if ('error' in res) return { ok: false, reason: res.error }
    s = res.state
  } else {
    if (!hitMine) return { ok: false, reason: 'claimed bust but no revealed tile was a mine' }
  }

  // 4) the claimed multiplier must equal the honestly recomputed one (rejects inflation).
  if (s.multiplierX100 !== claim.claimedMultiplierX100) {
    return { ok: false, reason: 'claimed multiplier does not match honest replay' }
  }
  return { ok: true, state: s }
}

// ---------------------------------------------------------------------------
// abi encoding (on-chain mirror) — owns the gameStateHash preimage
// ---------------------------------------------------------------------------

/**
 * Canonical ABI encoding of MinesState. Tuple order is law — mirrors MinesRules.sol:
 *   (uint8 phase, uint16 tiles, uint16 mines, bytes32 commit,
 *    uint8[] revealed, uint256 multiplierX100, uint16 bustTile, bool busted)
 * `busted` distinguishes bustTile=null (false) from bustTile=0 (true).
 */
export const GAME_STATE_ABI = [
  { type: 'uint8' },    // phase
  { type: 'uint16' },   // tiles
  { type: 'uint16' },   // mines
  { type: 'bytes32' },  // commit
  { type: 'uint8[]' },  // revealed
  { type: 'uint256' },  // multiplierX100
  { type: 'uint16' },   // bustTile (0 when busted=false)
  { type: 'bool' },     // busted
] as const

export function encodeGameState(s: MinesState): Hex {
  return encodeAbiParameters(GAME_STATE_ABI as any, [
    s.phase,
    s.config.tiles,
    s.config.mines,
    s.commit,
    s.revealed,
    s.multiplierX100,
    s.bustTile ?? 0,
    s.bustTile !== null,
  ]) as Hex
}

/** keccak256 of the canonical state encoding — this is `SessionState.gameStateHash`. */
export function hashGameState(s: MinesState): Hex {
  return keccak256(encodeGameState(s))
}

export const MOVE_KIND = { REVEAL: 0, CASH_OUT: 1 } as const

/** Canonical ABI encoding of a co-signed Mines move (kind ‖ payload). */
export function encodeMove(m: MinesMove): Hex {
  const payload = m.kind === 'REVEAL'
    ? encodeAbiParameters([{ type: 'uint16' }], [m.tile])
    : ('0x' as Hex)
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [MOVE_KIND[m.kind], payload]) as Hex
}

export { ZERO32 as MINES_ZERO32 }
