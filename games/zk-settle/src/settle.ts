import type { Hex } from 'viem'
import { dice, limbo, roundRandom } from '@msgboard/games'
import { compileCircuit, type Compiled } from './compile'
import { prove } from './prove'
import { verify } from './verify'
import { pedersenCommit, type PedersenPoint } from './pedersen'
import {
  diceSettleInputs,
  diceSettleCommitments,
  commitmentsToPublicInputs,
  type DiceSettleAmounts,
  type DiceSettleBlindings,
  type DiceSettleCommitments,
} from './diceSettle'
import { limboSettleInputs } from './limboSettle'
import { GAME_DICE, GAME_LIMBO } from './gameId'

/**
 * Task 6 — the unified off-chain M1 E2E settle API (dice + limbo).
 *
 * A single surface that ties Tasks 2-5 together end to end: take a real round
 * (real serverSeed/clientSeed/stake/balances + params), build the witness
 * (hidden amounts + their Pedersen commitments + the public seed commits +
 * targetX100), PROVE, then let an INDEPENDENT verifier check the proof +
 * validate the public commitments + conservation WITHOUT learning the hidden
 * amounts.
 *
 * The circuits, witness builders and Pedersen primitive are REUSED verbatim
 * from Tasks 2-5; this module is integration + a clean API only — no new crypto.
 *
 * The two games share ONE witness/commitment shape (five hidden amounts: stake,
 * open/final player+house balances). The only per-game differences are which
 * circuit project compiles and which `*SettleInputs` builder runs; both are
 * selected by `game`.
 */

/** Which game's privacy settle circuit to use. */
export type SettleGame = 'dice' | 'limbo'

/** The canonical gameId (mirrors @msgboard/games) for a SettleGame. */
export function settleGameId(game: SettleGame): number {
  return game === 'dice' ? GAME_DICE : GAME_LIMBO
}

/**
 * A real round to settle. The seeds/target/stake/openBalances are the round
 * facts; the blindings are the caller's fresh randomness for the five Pedersen
 * commitments. nonce is hardcoded 1 (same soundness rule as the circuits).
 */
export interface SettleRound {
  game: SettleGame
  serverSeed: Hex
  clientSeed: Hex
  targetX100: bigint
  stake: bigint
  openBalancePlayer: bigint
  openBalanceHouse: bigint
  blindings: SettleBlindings
}

export interface SettleBlindings {
  stake: bigint
  openBalancePlayer: bigint
  openBalanceHouse: bigint
  finalBalancePlayer: bigint
  finalBalanceHouse: bigint
}

/** The five conserved amounts produced by settling a round. */
export interface SettleAmounts {
  stake: bigint
  openBalancePlayer: bigint
  openBalanceHouse: bigint
  finalBalancePlayer: bigint
  finalBalanceHouse: bigint
}

/** The canonical (Track-1) outcome of a round: the recompute settle math. */
export interface SettleOutcome {
  win: boolean
  playerDelta: bigint
  finalBalancePlayer: bigint
  finalBalanceHouse: bigint
}

/** The result of a prove: the proof + its public inputs + the five commitments. */
export interface SettleProof {
  game: SettleGame
  proof: Uint8Array
  publicInputs: string[]
  /** The five public Pedersen commitments, in the circuit's output order. */
  commitments: DiceSettleCommitments
  /** The conserved amounts that were proven (kept for test/debug; NOT public). */
  amounts: SettleAmounts
}

const game = (g: SettleGame) => (g === 'dice' ? dice : limbo)

/**
 * Track-1 (recompute) settle: derive r from the seeds (nonce 1) and run the REAL
 * `dice.settleRound` / `limbo.settleRound` from @msgboard/games — the public
 * recompute path — to produce the conserved final balances. This is the
 * equivalence baseline the privacy circuit must agree with.
 */
export function trackOneSettle(round: SettleRound): SettleOutcome {
  const r = roundRandom(round.serverSeed, round.clientSeed, 1n)
  const o = game(round.game).settleRound(round.stake, { targetX100: round.targetX100 }, r)
  return {
    win: o.win,
    playerDelta: o.playerDelta,
    finalBalancePlayer: round.openBalancePlayer + o.playerDelta,
    finalBalanceHouse: round.openBalanceHouse - o.playerDelta,
  }
}

/** The conserved five amounts for a round, from the Track-1 outcome. */
export function settleAmounts(round: SettleRound): SettleAmounts {
  const o = trackOneSettle(round)
  return {
    stake: round.stake,
    openBalancePlayer: round.openBalancePlayer,
    openBalanceHouse: round.openBalanceHouse,
    finalBalancePlayer: o.finalBalancePlayer,
    finalBalanceHouse: o.finalBalanceHouse,
  }
}

// Compiled-circuit cache: compiling is the slow step, so prove + verify reuse it.
const circuitCache = new Map<SettleGame, Promise<Compiled>>()
function circuitFor(g: SettleGame): Promise<Compiled> {
  let c = circuitCache.get(g)
  if (!c) {
    c = compileCircuit(g === 'dice' ? 'test-circuits/diceSettle' : 'test-circuits/limboSettle')
    circuitCache.set(g, c)
  }
  return c
}

/**
 * PROVE a round's privacy settlement. Builds the conserved witness from the REAL
 * recompute outcome, runs the matching game circuit, and returns the proof, its
 * public inputs (seed commits + targetX100 + the five commitments — NO amounts),
 * and the five commitment points.
 *
 * The hidden amounts never leave the witness: a verifier of the returned
 * `{ proof, publicInputs }` learns only the commitments + public params.
 */
export async function proveSettle(round: SettleRound): Promise<SettleProof> {
  const amounts = settleAmounts(round)
  const blindings: SettleBlindings = round.blindings
  const witness = {
    serverSeed: round.serverSeed,
    clientSeed: round.clientSeed,
    targetX100: round.targetX100,
    amounts: amounts as DiceSettleAmounts,
    blindings: blindings as DiceSettleBlindings,
  }
  const c = await circuitFor(round.game)
  const inputs =
    round.game === 'dice' ? diceSettleInputs(witness) : limboSettleInputs(witness)
  const { proof, publicInputs } = await prove(c, inputs)
  const commitments = await diceSettleCommitments(amounts, blindings)
  return { game: round.game, proof, publicInputs, commitments, amounts }
}

/** The slice of public inputs that should be the five (x,y) commitment fields. */
function commitmentTail(publicInputs: string[]): string[] {
  return publicInputs.slice(publicInputs.length - 10)
}

/**
 * INDEPENDENT verify. Given ONLY `{ proof, publicInputs, game }` — never the
 * witness — a third party:
 *   1. cryptographically verifies the UltraHonk proof (this alone attests the
 *      in-circuit conservation: a witness whose claimed conservation is wrong
 *      cannot produce a valid proof), and
 *   2. confirms the public-input shape: the trailing 10 fields parse as the five
 *      commitment points and none of them is a trivial/empty point.
 * It learns NO hidden amount in the process.
 *
 * `expectedCommitments` (optional) lets a verifier who was independently handed
 * the commitments (e.g. from the on-chain channel state) assert the proof is
 * bound to exactly those commitments — still without any amount.
 */
export async function verifySettle(
  proof: Uint8Array,
  publicInputs: string[],
  game: SettleGame,
  expectedCommitments?: DiceSettleCommitments,
): Promise<boolean> {
  const c = await circuitFor(game)
  let ok: boolean
  try {
    ok = await verify(c, proof, publicInputs)
  } catch {
    // A proof for a different circuit (or malformed inputs) can throw inside
    // bb.js rather than returning false; treat any verify error as "invalid".
    return false
  }
  if (!ok) return false

  // Validate the public commitment fields are well-formed points (non-zero).
  const tail = commitmentTail(publicInputs)
  if (tail.length !== 10) return false
  for (const h of tail) {
    if (BigInt(h) === 0n) return false
  }

  if (expectedCommitments) {
    const expected = commitmentsToPublicInputs(expectedCommitments).map((h) => BigInt(h))
    const actual = tail.map((h) => BigInt(h))
    for (let i = 0; i < 10; i++) if (actual[i] !== expected[i]) return false
  }
  return true
}

export type { PedersenPoint }
