import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS } from './game'

/**
 * LADDER — a generalized co-signed step-ladder engine, the shared machinery behind the stateful
 * "climb / push-your-luck" games (Towers, Chicken, Firewalk, Heist, Hi-Lo, Greed Dice). It is the
 * mines pattern, generalized: a hidden layout is committed up front (here DERIVED from the sealed
 * round seed, never house-placed), the player takes co-signed steps, a running multiplier grows on
 * each success, and the player either cashes out or busts.
 *
 * The engine is pure and game-agnostic. Each game supplies a `resolveStep(stepIndex, choice)` that
 * reads its OWN seed-derived layout and returns `{ safe, multiplierX100 }`. The engine never sees the
 * layout — exactly as mines' `reveal(state, tile, isMine)` is fed the answer by the holder of the
 * board — so each co-signed step keeps the rest of the layout secret. Disputes replay the revealed
 * seed through the same resolver. This keeps every ladder game provably fair: the layout is a pure
 * function of the committed two-sided seed, recomputable by anyone.
 */

// (1 - edge) in hundredths: (10000 - 100)/100 == 99. Shared edge helper for ladder games.
const ONE_MINUS_EDGE_X100 = (10_000n - EDGE_BPS) / HUNDREDTHS // 99n

/** Apply the 1% house edge to a "fair" multiplier in hundredths. */
export function applyLadderEdgeX100(fairX100: bigint): bigint {
  return (fairX100 * ONE_MINUS_EDGE_X100) / HUNDREDTHS
}

/** Running edged multiplier after `steps` safe steps each worth a fair factor of num/den:
 *  edged((num/den)^steps). Computed as one rational division to avoid compounding rounding. 100 at k=0. */
export function compoundFairEdgedX100(num: number, den: number, steps: number): bigint {
  let n = 1n
  let d = 1n
  for (let i = 0; i < steps; i++) {
    n *= BigInt(num)
    d *= BigInt(den)
  }
  return applyLadderEdgeX100((n * HUNDREDTHS) / d)
}

export enum LadderPhase {
  PLAYING = 0,
  CASHED_OUT = 1,
  BUSTED = 2,
}

/** The per-step answer supplied by a game's resolver: was the step safe, and the running (edged)
 *  multiplier AFTER a safe step. On an unsafe step the multiplier is irrelevant (session busts). */
export interface StepOutcome {
  safe: boolean
  /** running edged multiplier in hundredths after this safe step (ignored when !safe). */
  multiplierX100: bigint
}

/** Co-signed running state of a ladder session. Field order is consensus — any Solidity mirror MUST
 *  match `LADDER_STATE_ABI`. The hidden layout is NOT here; only its commitment is. */
export interface LadderState {
  phase: LadderPhase
  /** commitment to the hidden layout = keccak256(abi.encode(uint256 seed)). */
  commit: Hex
  /** successful steps taken so far (k); 0 at start. */
  step: number
  /** ladder height — after this many safe steps the player is forced to cash out (terminal win). */
  maxSteps: number
  /** running edged multiplier in hundredths (100 == 1.00x). 100 at step 0. */
  multiplierX100: bigint
  /** the player's choice at each taken step, in order (for transcript + dispute replay). */
  choices: number[]
  /** the step index that busted (0-based), or null. Only set in BUSTED. */
  bustStep: number | null
}

export type LadderResult = { state: LadderState } | { error: string }

/** Commit to the hidden layout seed: keccak256(abi.encode(uint256 seed)). */
export function commitLayout(seed: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }], [seed]))
}

/** Start a ladder session from a layout commitment and a ladder height. */
export function startLadder(commit: Hex, maxSteps: number): LadderState {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('ladder: maxSteps must be >= 1')
  return { phase: LadderPhase.PLAYING, commit, step: 0, maxSteps, multiplierX100: HUNDREDTHS, choices: [], bustStep: null }
}

/**
 * Take one step. `outcome` is supplied by the game (holding the seed-derived layout): on a safe step
 * the running multiplier advances to `outcome.multiplierX100` and, if the ladder top is reached, the
 * session auto-cashes-out; on an unsafe step the session busts.
 */
export function ladderAdvance(s: LadderState, choice: number, outcome: StepOutcome): LadderResult {
  const err = (e: string): LadderResult => ({ error: `ladder: ${e}` })
  if (s.phase !== LadderPhase.PLAYING) return err(`step in terminal phase ${s.phase}`)
  if (s.step >= s.maxSteps) return err('ladder already at the top')
  if (!Number.isInteger(choice) || choice < 0) return err('choice out of range')

  const choices = [...s.choices, choice]
  if (!outcome.safe) {
    return { state: { ...s, phase: LadderPhase.BUSTED, choices, bustStep: s.step, multiplierX100: 0n } }
  }
  const step = s.step + 1
  const atTop = step >= s.maxSteps
  return {
    state: {
      ...s,
      step,
      choices,
      multiplierX100: outcome.multiplierX100,
      phase: atTop ? LadderPhase.CASHED_OUT : LadderPhase.PLAYING, // reaching the top is a forced win
    },
  }
}

/** Cash out the running multiplier. Valid while PLAYING with at least one safe step. */
export function ladderCashOut(s: LadderState): LadderResult {
  const err = (e: string): LadderResult => ({ error: `ladder: ${e}` })
  if (s.phase !== LadderPhase.PLAYING) return err(`cash out in terminal phase ${s.phase}`)
  if (s.step === 0) return err('cannot cash out before any step')
  return { state: { ...s, phase: LadderPhase.CASHED_OUT } }
}

/** Signed player delta for a terminal state. CASHED_OUT: stake*(mult-1). BUSTED: -stake. else 0. */
export function ladderPlayerDelta(s: LadderState, stake: bigint): bigint {
  switch (s.phase) {
    case LadderPhase.CASHED_OUT:
      return (stake * s.multiplierX100) / HUNDREDTHS - stake
    case LadderPhase.BUSTED:
      return -stake
    default:
      return 0n
  }
}

// ---------------------------------------------------------------------------
// dispute / verify (adjudication) — generic replay through a game resolver
// ---------------------------------------------------------------------------

export interface LadderClaim {
  commit: Hex
  maxSteps: number
  /** the ordered choices the player claims to have made. */
  choices: number[]
  /** whether the player claims to have cashed out (true) or busted (false). */
  cashedOut: boolean
  /** the running edged multiplier (hundredths) claimed at settlement. */
  claimedMultiplierX100: bigint
}

export interface LadderVerdict {
  ok: boolean
  reason?: string
  state?: LadderState
}

/**
 * Adjudicate a disputed ladder session. The loser reveals the layout `seed`; we recheck the
 * commitment, then replay the claimed choices through the game's `resolveStep(stepIndex, choice)`
 * (which reads the layout derived from `seed`), and confirm the claimed multiplier/terminal phase.
 */
export function verifyLadder(
  claim: LadderClaim,
  seed: bigint,
  resolveStep: (stepIndex: number, choice: number, currentMultiplierX100: bigint) => StepOutcome,
): LadderVerdict {
  if (commitLayout(seed) !== claim.commit) return { ok: false, reason: 'seed does not match commitment' }

  let s = startLadder(claim.commit, claim.maxSteps)
  for (let i = 0; i < claim.choices.length; i++) {
    const res = ladderAdvance(s, claim.choices[i]!, resolveStep(i, claim.choices[i]!, s.multiplierX100))
    if ('error' in res) return { ok: false, reason: res.error }
    s = res.state
    if (s.phase !== LadderPhase.PLAYING) break
  }

  const busted = s.phase === LadderPhase.BUSTED
  if (claim.cashedOut) {
    if (busted) return { ok: false, reason: 'claimed cash-out but a step busted' }
    if (s.phase === LadderPhase.PLAYING) {
      const res = ladderCashOut(s)
      if ('error' in res) return { ok: false, reason: res.error }
      s = res.state
    }
  } else if (!busted) {
    return { ok: false, reason: 'claimed bust but no step busted' }
  }

  if (s.multiplierX100 !== claim.claimedMultiplierX100) {
    return { ok: false, reason: 'claimed multiplier does not match honest replay' }
  }
  return { ok: true, state: s }
}

// ---------------------------------------------------------------------------
// abi encoding (on-chain mirror) — owns the gameStateHash preimage
// ---------------------------------------------------------------------------

/** Canonical ABI encoding of LadderState. Tuple order is law for any Solidity mirror:
 *   (uint8 phase, bytes32 commit, uint32 step, uint32 maxSteps, uint256 multiplierX100,
 *    uint32[] choices, uint32 bustStep, bool busted)  — `busted` distinguishes bustStep=null. */
export const LADDER_STATE_ABI = [
  { type: 'uint8' },
  { type: 'bytes32' },
  { type: 'uint32' },
  { type: 'uint32' },
  { type: 'uint256' },
  { type: 'uint32[]' },
  { type: 'uint32' },
  { type: 'bool' },
] as const

export function encodeLadderState(s: LadderState): Hex {
  return encodeAbiParameters(LADDER_STATE_ABI as any, [
    s.phase,
    s.commit,
    s.step,
    s.maxSteps,
    s.multiplierX100,
    s.choices,
    s.bustStep ?? 0,
    s.bustStep !== null,
  ]) as Hex
}

export function hashLadderState(s: LadderState): Hex {
  return keccak256(encodeLadderState(s))
}
