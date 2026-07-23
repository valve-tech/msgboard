/// Pure side-pot algorithm + deterministic pot splitting. No deps — mirrored byte-for-byte
/// by the Solidity HoldemRules side-pot routine (parity-tested in Task 5/7).

/// A layered pot: `amount` wei contested by the (non-folded) seats in `eligible`
/// (ascending seat indices). The plan's HoldemState.sidePots shape.
export interface SidePotTS {
  amount: bigint
  eligible: number[]
}

/**
 * Standard Texas-Hold'em side-pot construction.
 *
 * `totalContributed[i]` is the whole-hand chips seat i has put into the pot (already
 * net of any returned uncalled bet — see the betting layer's returnUncalled). `folded[i]`
 * marks a seat that surrendered its hand: its chips REMAIN in the pots (they were matched
 * by live seats) but it is never eligible to win any pot.
 *
 * Algorithm: walk the distinct contribution levels ascending. Each level defines a layer
 * whose width is (level - prevLevel); the layer's amount is that width times the number of
 * seats (folded or not) that contributed at least `level`. The layer is contested only by
 * the NON-folded seats that reached `level`. Layers with zero amount or no eligible seat
 * are dropped (a layer can have chips but no live claimant only if every contributor at
 * that level folded — those chips fold down into the nearest lower live layer instead).
 *
 * Conservation: Σ pots.amount == Σ totalContributed, always.
 */
export function buildSidePots(totalContributed: bigint[], folded: boolean[]): SidePotTS[] {
  const n = totalContributed.length
  if (folded.length !== n) throw new Error('sidePots: length mismatch')
  for (const c of totalContributed) if (c < 0n) throw new Error('sidePots: negative contribution')

  // Distinct positive contribution levels, ascending.
  const levels = [...new Set(totalContributed.filter((c) => c > 0n).map((c) => c.toString()))]
    .map((s) => BigInt(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const pots: SidePotTS[] = []
  let prev = 0n
  // Carry chips from a layer that has no live (non-folded) claimant down into the next
  // live layer, so dead-money never vanishes and conservation holds.
  let deadCarry = 0n
  for (const level of levels) {
    const width = level - prev
    // every seat (folded or not) that put in at least `level` funds this layer's width
    let contributors = 0
    const eligible: number[] = []
    for (let i = 0; i < n; i++) {
      if (totalContributed[i]! >= level) {
        contributors++
        if (!folded[i]) eligible.push(i)
      }
    }
    const amount = width * BigInt(contributors) + deadCarry
    if (eligible.length === 0) {
      // No live claimant for this layer; its chips roll forward to the next live layer.
      deadCarry = amount
    } else {
      // Merge into the previous pot when the eligible set is identical — a new side pot
      // only forms when eligibility actually shrinks (a seat went all-in below this level).
      const top = pots[pots.length - 1]
      if (top && sameEligible(top.eligible, eligible)) top.amount += amount
      else pots.push({ amount, eligible })
      deadCarry = 0n
    }
    prev = level
  }
  // If the very last (top) layer had no live claimant, fold its chips into the last live
  // pot (the live seats that reached the highest contested level). If there is no live pot
  // at all (everyone folded — shouldn't happen in a real hand), the chips have nowhere to
  // go; surface that as an empty result with the dead carry dropped is wrong, so attach it
  // to a lone pot eligible to nobody only as a last resort. In practice the betting layer
  // guarantees ≥1 live seat, so deadCarry is 0 here whenever pots is non-empty.
  if (deadCarry > 0n) {
    if (pots.length > 0) pots[pots.length - 1]!.amount += deadCarry
    else pots.push({ amount: deadCarry, eligible: [] })
  }
  return pots
}

/// Two ascending seat-index lists name the same eligible set.
function sameEligible(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/// One seat's share of a split pot.
export interface PotShare {
  seat: number
  amount: bigint
}

/**
 * Split `amount` evenly among `winners`, assigning any odd-chip remainder
 * deterministically. The remainder rule (standard live-poker convention): the first
 * `remainder` winners encountered scanning clockwise from the seat immediately left of the
 * button (button+1, button+2, … mod n) each receive one extra chip. This is reproducible
 * from (button, nSeats) alone and is mirrored by the Solidity settlement.
 *
 * `winners` need not be sorted; the returned shares are ordered by the same clockwise scan
 * so the +1 recipients are unambiguous. Conserves: Σ shares == amount.
 */
export function splitPot(amount: bigint, winners: number[], button: number, nSeats: number): PotShare[] {
  if (winners.length === 0) throw new Error('splitPot: no winners')
  const set = new Set(winners)
  // Clockwise order from button+1.
  const ordered: number[] = []
  for (let k = 1; k <= nSeats; k++) {
    const seat = (button + k) % nSeats
    if (set.has(seat)) ordered.push(seat)
  }
  // winners outside [0,nSeats) (defensive) — append in given order so none are dropped.
  for (const w of winners) if (!ordered.includes(w)) ordered.push(w)

  const k = BigInt(ordered.length)
  const base = amount / k
  const remainder = amount - base * k // 0..k-1, each of the first `remainder` gets +1
  return ordered.map((seat, idx) => ({
    seat,
    amount: base + (BigInt(idx) < remainder ? 1n : 0n),
  }))
}
