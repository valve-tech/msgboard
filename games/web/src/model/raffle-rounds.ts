import * as viem from 'viem'

/** GameBase.STALE_BLOCKS — the liveness timeout after which an armed-but-seedless round refunds. */
const STALE_BLOCKS = 200n

/** Log provenance carried on every event so the UI can prove where each fact came from. */
export type EventMeta = { blockNumber?: bigint; transactionHash?: viem.Hex }

/** Decoded event args the round derivation consumes. blockNumber fields come from the logs. */
export type RaffleEvents = {
  opened: ({ roundId: viem.Hex; stake: bigint; threshold: bigint; period: bigint; subsetHash: viem.Hex } & EventMeta)[]
  committed: ({ ticketId: bigint; roundId: viem.Hex; player: viem.Hex; commitment: viem.Hex; blockNumber: bigint } & EventMeta)[]
  ticketCancelled: { ticketId: bigint }[]
  armed: ({ roundId: viem.Hex; key: viem.Hex; blockNumber: bigint } & EventMeta)[]
  drawn: ({ roundId: viem.Hex; draw: bigint; claimDeadline: bigint } & EventMeta)[]
  revealed: ({ ticketId: bigint; roundId: viem.Hex; guess: bigint; distance: bigint; leading: boolean } & EventMeta)[]
  finalised: ({ roundId: viem.Hex; winner: viem.Hex; payout: bigint; fee: bigint } & EventMeta)[]
  noContest: { roundId: viem.Hex; potPerValidator: bigint }[]
  ticketRefunded: { ticketId: bigint }[]
}

export type TicketView = {
  ticketId: bigint
  player: viem.Hex
  commitment: viem.Hex
  committedAtBlock: bigint
  mine: boolean
  cancelled: boolean
  refunded: boolean
  revealed: boolean
  guess?: bigint
  distance?: bigint
  /** Whether this ticket is the CURRENT provisional winner (the last leading reveal). */
  leading: boolean
  commitTx?: viem.Hex
  revealTx?: viem.Hex
  revealedAtBlock?: bigint
}

export type RaffleRoundView = {
  roundId: viem.Hex
  stake: bigint
  threshold: bigint
  period: bigint
  subsetHash: viem.Hex
  phase: 'filling' | 'drawing' | 'claiming' | 'paid' | 'no-contest'
  tickets: TicketView[]
  /** Active (not cancelled) commits — what the contract compares to the threshold. */
  commitCount: bigint
  key?: viem.Hex
  armedAtBlock?: bigint
  draw?: bigint
  claimDeadline?: bigint
  /** Reveal allowed while block.number <= claimDeadline (the contract's WindowClosed check). */
  revealOpen?: boolean
  /** Finalise allowed once block.number > claimDeadline (the contract's WindowOpen check). */
  finaliseOpen?: boolean
  /** Blocks until the reveal window closes: claimDeadline - currentBlock, floored at 0. */
  blocksUntilClose?: bigint
  winner?: viem.Hex
  payout?: bigint
  /** Armed with no draw for STALE_BLOCKS — surface the per-ticket refund path. */
  staleRefundCandidate: boolean
  openedAtBlock?: bigint
  armTx?: viem.Hex
  drawnAtBlock?: bigint
  drawTx?: viem.Hex
  finalisedAtBlock?: bigint
  finaliseTx?: viem.Hex
}

const sameAddress = (a: viem.Hex, b: viem.Hex) => a.toLowerCase() === b.toLowerCase()

/** Derive every round's view state from raw events plus the current block (passed in, not read). */
export const deriveRaffleRounds = (
  events: RaffleEvents,
  myAddress: viem.Hex | undefined,
  currentBlock: bigint,
): RaffleRoundView[] => {
  const cancelledTickets = new Set(events.ticketCancelled.map((t) => t.ticketId))
  const refundedTickets = new Set(events.ticketRefunded.map((t) => t.ticketId))
  const revealByTicket = new Map(events.revealed.map((r) => [r.ticketId, r]))
  // the provisional winner is the LAST reveal flagged leading, per round
  const leaderByRound = new Map<viem.Hex, bigint>()
  for (const r of events.revealed) {
    if (r.leading) leaderByRound.set(r.roundId, r.ticketId)
  }
  const armedByRound = new Map(events.armed.map((a) => [a.roundId, a]))
  const drawnByRound = new Map(events.drawn.map((d) => [d.roundId, d]))
  const finalisedByRound = new Map(events.finalised.map((f) => [f.roundId, f]))
  const noContestRounds = new Set(events.noContest.map((n) => n.roundId))

  return events.opened.map((opened) => {
    const tickets: TicketView[] = events.committed
      .filter((c) => c.roundId === opened.roundId)
      .map((c) => {
        const reveal = revealByTicket.get(c.ticketId)
        return {
          ticketId: c.ticketId,
          player: c.player,
          commitment: c.commitment,
          committedAtBlock: c.blockNumber,
          mine: myAddress !== undefined && sameAddress(c.player, myAddress),
          cancelled: cancelledTickets.has(c.ticketId),
          refunded: refundedTickets.has(c.ticketId),
          revealed: reveal !== undefined,
          guess: reveal?.guess,
          distance: reveal?.distance,
          leading: leaderByRound.get(opened.roundId) === c.ticketId,
          commitTx: c.transactionHash,
          revealTx: reveal?.transactionHash,
          revealedAtBlock: reveal?.blockNumber,
        }
      })

    const armed = armedByRound.get(opened.roundId)
    const drawn = drawnByRound.get(opened.roundId)
    const finalised = finalisedByRound.get(opened.roundId)
    const phase: RaffleRoundView['phase'] = finalised
      ? 'paid'
      : noContestRounds.has(opened.roundId)
        ? 'no-contest'
        : drawn
          ? 'claiming'
          : armed
            ? 'drawing'
            : 'filling'

    const revealOpen = drawn ? currentBlock <= drawn.claimDeadline : undefined
    return {
      roundId: opened.roundId,
      stake: opened.stake,
      threshold: opened.threshold,
      period: opened.period,
      subsetHash: opened.subsetHash,
      phase,
      tickets,
      commitCount: BigInt(tickets.filter((t) => !t.cancelled).length),
      key: armed?.key,
      armedAtBlock: armed?.blockNumber,
      draw: drawn?.draw,
      claimDeadline: drawn?.claimDeadline,
      revealOpen,
      finaliseOpen: drawn ? !revealOpen && phase === 'claiming' : undefined,
      blocksUntilClose: drawn
        ? drawn.claimDeadline > currentBlock
          ? drawn.claimDeadline - currentBlock
          : 0n
        : undefined,
      winner: finalised?.winner,
      payout: finalised?.payout,
      openedAtBlock: opened.blockNumber,
      armTx: armed?.transactionHash,
      drawnAtBlock: drawn?.blockNumber,
      drawTx: drawn?.transactionHash,
      finalisedAtBlock: finalised?.blockNumber,
      finaliseTx: finalised?.transactionHash,
      staleRefundCandidate:
        phase === 'drawing' && armed !== undefined && currentBlock >= armed.blockNumber + STALE_BLOCKS,
    }
  })
}
