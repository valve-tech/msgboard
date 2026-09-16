import * as viem from 'viem'
import { roundRandom, commitSeed } from '@msgboard/games'

/**
 * Stake-weighted pari-mutuel pool — the continuous-amount sibling of `@msgboard/games`'s
 * ticket-count `lottery.ts`. That module models a FIXED ticket price with an integer quantity
 * (`LotteryTicket.count`), which is genuinely load-bearing there: it has its own dedicated
 * fairness test suite built around integer ticket indices, and nothing outside this screen
 * depends on continuous amounts, so it isn't touched. Here every entrant instead wagers an
 * arbitrary continuous stake (in wei) straight from `StakeInput`/`parseStake`, and the draw
 * picks a winning POINT in [0, totalStake) — proportional to stake, not ticket count — using
 * the same underlying commit-reveal RNG (`roundRandom`) for identical fairness guarantees.
 */
export type LotteryEntry = { buyer: viem.Hex; stake: bigint }

export type LotteryPoolDraw = {
  /** the winning point in [0, totalStake), for auditing. */
  winningPoint: bigint
  winner: viem.Hex
  totalStake: bigint
  participationCommit: viem.Hex
  raw: bigint
}

export type LotteryPoolSettlement = { pool: bigint; rake: bigint; prize: bigint }

const BPS = 10_000n

const assertEntries = (entries: LotteryEntry[]): bigint => {
  let total = 0n
  for (const e of entries) {
    if (e.stake <= 0n) throw new Error('lottery: stake must be a positive amount')
    total += e.stake
  }
  if (total === 0n) throw new Error('lottery: no stakes wagered')
  return total
}

/** total wei wagered across all entries. */
export const lotteryPoolTotal = (entries: LotteryEntry[]): bigint => assertEntries(entries)

/**
 * The participation commitment: keccak256 over the ordered (buyers, stakes). Binds the draw to the
 * exact final entry list — a late entrant (or the house, who commits its seed before the round
 * closes) can't steer the winner by changing who's in the pool or for how much.
 */
export const participationCommitByStake = (entries: LotteryEntry[]): viem.Hex => {
  assertEntries(entries)
  return viem.keccak256(
    viem.encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'uint256[]' }],
      [entries.map((e) => e.buyer), entries.map((e) => e.stake)],
    ),
  )
}

/** The owner of a given point in [0, totalStake), walking cumulative stake ranges in entry order. */
export const ownerAtPoint = (entries: LotteryEntry[], point: bigint): viem.Hex => {
  const total = assertEntries(entries)
  if (point < 0n || point >= total) throw new Error('lottery: point out of range')
  let cumulative = 0n
  for (const e of entries) {
    cumulative += e.stake
    if (point < cumulative) return e.buyer
  }
  throw new Error('lottery: unreachable') // assertEntries guarantees point < total
}

/** Draw the stake-weighted winning point from the revealed server seed + the final entry list. */
export const lotteryPoolDraw = (serverSeed: viem.Hex, entries: LotteryEntry[], nonce: bigint): LotteryPoolDraw => {
  const totalStake = assertEntries(entries)
  const participationCommit = participationCommitByStake(entries)
  const raw = roundRandom(serverSeed, participationCommit, nonce)
  const winningPoint = raw % totalStake
  return { winningPoint, winner: ownerAtPoint(entries, winningPoint), totalStake, participationCommit, raw }
}

/** Pool economics: pool = totalStake (sum of continuous wagers); rake = pool * rakeBps; prize = pool - rake. */
export const lotteryPoolSettle = (entries: LotteryEntry[], rakeBps: bigint): LotteryPoolSettlement => {
  const pool = assertEntries(entries)
  if (rakeBps < 0n || rakeBps >= BPS) throw new Error('lottery: rake out of range [0, 100%)')
  const rake = (pool * rakeBps) / BPS
  return { pool, rake, prize: pool - rake }
}

/**
 * Verify a claimed draw: the revealed seed must match the published commit AND recomputing the draw
 * from the (public) entry list must reproduce the claimed winning point/winner. Anyone can run this.
 */
export const verifyLotteryPoolDraw = (
  commit: viem.Hex,
  serverSeed: viem.Hex,
  entries: LotteryEntry[],
  nonce: bigint,
  claimed: { winningPoint: bigint; winner: viem.Hex },
): { ok: boolean; reason?: string } => {
  if (commitSeed(serverSeed) !== commit) return { ok: false, reason: 'seed does not match commit' }
  const draw = lotteryPoolDraw(serverSeed, entries, nonce)
  if (draw.winningPoint !== claimed.winningPoint) return { ok: false, reason: 'winning point mismatch' }
  if (draw.winner.toLowerCase() !== claimed.winner.toLowerCase()) return { ok: false, reason: 'winner mismatch' }
  return { ok: true }
}
