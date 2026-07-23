import { keccak256, encodeAbiParameters, type Hex } from 'viem'
import { commitSeed, roundRandom, subRandom } from './rng'

/**
 * Lottery — a pooled, pari-mutuel raffle draw. Unlike the house-banked games (a player vs the house
 * bankroll), this is players-vs-players: everyone buys tickets into one pool, a single seeded draw picks
 * the winning ticket(s), and the pool (minus a fixed rake) is paid out. The house never has bankroll
 * risk here — it only takes the rake — which is why this rides the existing raffle rails almost for free.
 *
 * PROVABLY FAIR — and crucially, ungrindable by EITHER side:
 *  - The house publishes `commit = keccak256(serverSeed)` BEFORE ticket sales close. At that moment it
 *    does not yet know the final set of buyers, so it cannot have ground its seed toward a chosen winner.
 *  - The draw's client-side entropy is `participationCommit(tickets)` — a hash of the FINAL ticket list.
 *    So the winning index is bound to exactly who bought what (any change to the buyers/counts changes
 *    the draw). A late buyer can't steer it either: they'd need `serverSeed`, but only its hash is public
 *    (preimage resistance). Neither party can predict or bias the outcome.
 *  - `winningTicket = roundRandom(serverSeed, participationCommit, nonce) % totalTickets`, recomputable
 *    by anyone from the revealed seed and the on-MsgBoard ticket list (`verifyLotteryDraw`).
 */

const BPS = 10_000n

/** A ticket purchase: `buyer` bought `count` tickets. Entries are kept in purchase order (the order is
 *  part of the participation commitment, so the ticket→owner mapping is canonical and auditable). */
export interface LotteryTicket {
  buyer: Hex
  count: number
}

export interface LotteryDraw {
  /** the winning ticket index in [0, totalTickets). */
  winningTicket: number
  /** the address that owns the winning ticket. */
  winner: Hex
  totalTickets: number
  /** the participation entropy folded into the draw (a hash of the final ticket list). */
  participationCommit: Hex
  /** the raw round random, for auditing. */
  raw: bigint
}

export interface LotterySettlement {
  /** total wagered into the pool (totalTickets * ticketPrice), in wei. */
  pool: bigint
  /** the house's cut, in wei. */
  rake: bigint
  /** the amount paid out to winner(s), in wei (pool - rake). */
  prize: bigint
}

function assertTickets(tickets: LotteryTicket[]): number {
  let total = 0
  for (const t of tickets) {
    if (!Number.isInteger(t.count) || t.count <= 0) throw new Error('lottery: ticket count must be a positive integer')
    total += t.count
  }
  if (total === 0) throw new Error('lottery: no tickets sold')
  return total
}

/** total tickets across all buyers. */
export function lotteryTotalTickets(tickets: LotteryTicket[]): number {
  return assertTickets(tickets)
}

/**
 * The participation commitment: keccak256 over the ordered (buyers, counts). This is the client-seed of
 * the draw, binding the outcome to the exact final ticket list — so the house (which committed its
 * server seed earlier, blind) cannot have ground a favorable winner. On-chain reproducible.
 */
export function participationCommit(tickets: LotteryTicket[]): Hex {
  assertTickets(tickets)
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'uint256[]' }],
      [tickets.map((t) => t.buyer), tickets.map((t) => BigInt(t.count))],
    ),
  )
}

/** the owner of ticket index `idx` (0-based), walking the purchase entries. */
export function ticketOwner(tickets: LotteryTicket[], idx: number): Hex {
  const total = assertTickets(tickets)
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) throw new Error('lottery: ticket index out of range')
  let cumulative = 0
  for (const t of tickets) {
    cumulative += t.count
    if (idx < cumulative) return t.buyer
  }
  throw new Error('lottery: unreachable') // assertTickets guarantees idx < total
}

/** Draw the single grand-prize winning ticket from the revealed server seed + the ticket list. */
export function lotteryDraw(serverSeed: Hex, tickets: LotteryTicket[], nonce: bigint): LotteryDraw {
  const totalTickets = assertTickets(tickets)
  const pc = participationCommit(tickets)
  const raw = roundRandom(serverSeed, pc, nonce)
  const winningTicket = Number(raw % BigInt(totalTickets))
  return { winningTicket, winner: ticketOwner(tickets, winningTicket), totalTickets, participationCommit: pc, raw }
}

/**
 * Draw `k` DISTINCT winning tickets (prize tiers 1..k) from one seeded round, using the `subRandom`
 * stream with rejection of already-drawn indices. The same buyer may win multiple tiers if they hold
 * multiple winning tickets — fair, since each ticket is an independent entry. Deterministic/recomputable.
 */
export function lotteryDrawMultiple(serverSeed: Hex, tickets: LotteryTicket[], nonce: bigint, k: number): LotteryDraw[] {
  const totalTickets = assertTickets(tickets)
  if (!Number.isInteger(k) || k < 1) throw new Error('lottery: must draw at least one winner')
  if (k > totalTickets) throw new Error('lottery: cannot draw more distinct winners than tickets')
  const pc = participationCommit(tickets)
  const base = roundRandom(serverSeed, pc, nonce)
  const drawn = new Set<number>()
  const winners: LotteryDraw[] = []
  for (let stream = 0; winners.length < k; stream++) {
    const idx = Number(subRandom(base, BigInt(stream)) % BigInt(totalTickets))
    if (drawn.has(idx)) continue // rejection sampling keeps the tiers distinct
    drawn.add(idx)
    winners.push({ winningTicket: idx, winner: ticketOwner(tickets, idx), totalTickets, participationCommit: pc, raw: base })
  }
  return winners
}

/** Pool economics: pool = totalTickets * ticketPrice; rake = pool * rakeBps; prize = pool - rake. */
export function lotterySettle(tickets: LotteryTicket[], ticketPriceWei: bigint, rakeBps: bigint): LotterySettlement {
  const total = assertTickets(tickets)
  if (ticketPriceWei <= 0n) throw new Error('lottery: ticket price must be positive')
  if (rakeBps < 0n || rakeBps >= BPS) throw new Error('lottery: rake out of range [0, 100%)')
  const pool = BigInt(total) * ticketPriceWei
  const rake = (pool * rakeBps) / BPS
  return { pool, rake, prize: pool - rake }
}

/**
 * Split the prize across `k` tiers by `splitBps` (must sum to 10000). Any rounding dust from flooring is
 * added to the top tier, so Σ allocations == prize exactly (no wei created or lost). Returns wei per tier.
 */
export function lotteryPrizeSplit(prize: bigint, splitBps: bigint[]): bigint[] {
  if (splitBps.length === 0) throw new Error('lottery: empty split')
  const sum = splitBps.reduce((a, b) => a + b, 0n)
  if (sum !== BPS) throw new Error('lottery: split must sum to 10000 bps')
  const parts = splitBps.map((bps) => (prize * bps) / BPS)
  const dust = prize - parts.reduce((a, b) => a + b, 0n)
  parts[0]! += dust // give rounding dust to the grand prize
  return parts
}

/** the house's server-seed commitment for a lottery round (published before sales close). */
export function commitLotterySeed(serverSeed: Hex): Hex {
  return commitSeed(serverSeed)
}

/**
 * Verify a claimed draw: the revealed seed must match the published commit AND recomputing the draw from
 * the (public) ticket list must reproduce the claimed winning ticket. Anyone can run this.
 */
export function verifyLotteryDraw(
  commit: Hex,
  serverSeed: Hex,
  tickets: LotteryTicket[],
  nonce: bigint,
  claimed: { winningTicket: number; winner: Hex },
): { ok: boolean; reason?: string } {
  if (commitSeed(serverSeed) !== commit) return { ok: false, reason: 'seed does not match commit' }
  const draw = lotteryDraw(serverSeed, tickets, nonce)
  if (draw.winningTicket !== claimed.winningTicket) return { ok: false, reason: 'winning ticket mismatch' }
  if (draw.winner.toLowerCase() !== claimed.winner.toLowerCase()) return { ok: false, reason: 'winner mismatch' }
  return { ok: true }
}
