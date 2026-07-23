import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { deriveRaffleRounds, type RaffleEvents } from '../src/model/raffle-rounds'

const A = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as viem.Hex
const B = '0xBbbBBbbbBbbBbbbBbBBBBBBBBbbbBbBbBbbBbbBb' as viem.Hex
const ROUND = viem.keccak256(viem.toHex('round-1'))
const SUBSET_HASH = viem.keccak256(viem.toHex('subset'))
const stake = viem.parseEther('1')

const base: RaffleEvents = {
  opened: [],
  committed: [],
  ticketCancelled: [],
  armed: [],
  drawn: [],
  revealed: [],
  finalised: [],
  noContest: [],
  ticketRefunded: [],
}
const openedRound = { roundId: ROUND, stake, threshold: 3n, period: 5n, subsetHash: SUBSET_HASH }
const commit = (ticketId: bigint, player: viem.Hex, blockNumber: bigint) => ({
  ticketId,
  roundId: ROUND,
  player,
  commitment: viem.keccak256(viem.toHex(`c-${ticketId}`)),
  blockNumber,
})

describe('deriveRaffleRounds', () => {
  it('a fresh round is filling, counting only active commits', () => {
    const rounds = deriveRaffleRounds(
      {
        ...base,
        opened: [openedRound],
        committed: [commit(1n, A, 10n), commit(2n, B, 11n)],
        ticketCancelled: [{ ticketId: 2n }],
      },
      A,
      12n,
    )
    expect(rounds).to.have.length(1)
    expect(rounds[0]).to.deep.include({ roundId: ROUND, phase: 'filling', commitCount: 1n })
    expect(rounds[0]!.tickets.find((t) => t.ticketId === 1n)).to.deep.include({ mine: true, cancelled: false })
    expect(rounds[0]!.tickets.find((t) => t.ticketId === 2n)).to.deep.include({ cancelled: true })
  })

  it('armed moves to drawing; drawn moves to claiming with the draw and deadline', () => {
    const key = viem.keccak256(viem.toHex('key'))
    const drawing = deriveRaffleRounds(
      { ...base, opened: [openedRound], committed: [commit(1n, A, 10n)], armed: [{ roundId: ROUND, key, blockNumber: 20n }] },
      A,
      21n,
    )
    expect(drawing[0]!.phase).to.equal('drawing')

    const claiming = deriveRaffleRounds(
      {
        ...base,
        opened: [openedRound],
        committed: [commit(1n, A, 10n)],
        armed: [{ roundId: ROUND, key, blockNumber: 20n }],
        drawn: [{ roundId: ROUND, draw: 129n, claimDeadline: 121n }],
      },
      A,
      30n,
    )
    expect(claiming[0]).to.deep.include({ phase: 'claiming', draw: 129n, claimDeadline: 121n })
  })

  it('the reveal window boundary matches the contract: open AT the deadline block, closed one after', () => {
    const make = (currentBlock: bigint) =>
      deriveRaffleRounds(
        {
          ...base,
          opened: [openedRound],
          committed: [commit(1n, A, 10n)],
          drawn: [{ roundId: ROUND, draw: 5n, claimDeadline: 121n }],
        },
        A,
        currentBlock,
      )[0]!
    const atDeadline = make(121n)
    expect(atDeadline.revealOpen).to.equal(true)
    expect(atDeadline.finaliseOpen).to.equal(false)
    expect(atDeadline.blocksUntilClose).to.equal(0n)
    const afterDeadline = make(122n)
    expect(afterDeadline.revealOpen).to.equal(false)
    expect(afterDeadline.finaliseOpen).to.equal(true)
    const before = make(100n)
    expect(before.blocksUntilClose).to.equal(21n)
  })

  it('reveals mark tickets with guess/distance and track the current leader', () => {
    const rounds = deriveRaffleRounds(
      {
        ...base,
        opened: [openedRound],
        committed: [commit(1n, A, 10n), commit(2n, B, 11n)],
        drawn: [{ roundId: ROUND, draw: 129n, claimDeadline: 200n }],
        revealed: [
          { ticketId: 1n, roundId: ROUND, guess: 100n, distance: 29n, leading: true },
          { ticketId: 2n, roundId: ROUND, guess: 130n, distance: 1n, leading: true },
        ],
      },
      A,
      150n,
    )
    const [round] = rounds
    expect(round!.tickets.find((t) => t.ticketId === 1n)).to.deep.include({ revealed: true, guess: 100n, leading: false })
    expect(round!.tickets.find((t) => t.ticketId === 2n)).to.deep.include({ revealed: true, guess: 130n, leading: true })
  })

  it('finalised and no-contest terminal phases carry the outcome', () => {
    const paid = deriveRaffleRounds(
      {
        ...base,
        opened: [openedRound],
        committed: [commit(1n, A, 10n)],
        drawn: [{ roundId: ROUND, draw: 5n, claimDeadline: 100n }],
        finalised: [{ roundId: ROUND, winner: A, payout: stake * 3n, fee: 0n }],
      },
      A,
      150n,
    )
    expect(paid[0]).to.deep.include({ phase: 'paid', winner: A, payout: stake * 3n })

    const noContest = deriveRaffleRounds(
      {
        ...base,
        opened: [openedRound],
        committed: [commit(1n, A, 10n)],
        drawn: [{ roundId: ROUND, draw: 5n, claimDeadline: 100n }],
        noContest: [{ roundId: ROUND, potPerValidator: stake }],
      },
      A,
      150n,
    )
    expect(noContest[0]!.phase).to.equal('no-contest')
  })

  it('flags a stale drawing round as a refund candidate after the liveness timeout', () => {
    const key = viem.keccak256(viem.toHex('key'))
    const make = (currentBlock: bigint) =>
      deriveRaffleRounds(
        {
          ...base,
          opened: [openedRound],
          committed: [commit(1n, A, 10n)],
          armed: [{ roundId: ROUND, key, blockNumber: 20n }],
        },
        A,
        currentBlock,
      )[0]!
    expect(make(219n).staleRefundCandidate).to.equal(false) // 20 + 200 = 220 is the boundary
    expect(make(220n).staleRefundCandidate).to.equal(true)
  })
})

describe('provenance threading', () => {
  it('carries block numbers and tx hashes from the logs onto rounds and tickets', () => {
    const commitTx = viem.keccak256(viem.toHex('tx-commit'))
    const revealTx = viem.keccak256(viem.toHex('tx-reveal'))
    const armTx = viem.keccak256(viem.toHex('tx-arm'))
    const drawTx = viem.keccak256(viem.toHex('tx-draw'))
    const finaliseTx = viem.keccak256(viem.toHex('tx-finalise'))
    const rounds = deriveRaffleRounds(
      {
        ...base,
        opened: [{ ...openedRound, blockNumber: 9n }],
        committed: [{ ...commit(1n, A, 10n), transactionHash: commitTx }],
        armed: [{ roundId: ROUND, key: viem.keccak256(viem.toHex('key')), blockNumber: 12n, transactionHash: armTx }],
        drawn: [{ roundId: ROUND, draw: 7n, claimDeadline: 20n, blockNumber: 13n, transactionHash: drawTx }],
        revealed: [
          { ticketId: 1n, roundId: ROUND, guess: 7n, distance: 0n, leading: true, blockNumber: 14n, transactionHash: revealTx },
        ],
        finalised: [{ roundId: ROUND, winner: A, payout: stake, fee: 0n, blockNumber: 21n, transactionHash: finaliseTx }],
      },
      A,
      22n,
    )
    expect(rounds[0]).to.deep.include({
      openedAtBlock: 9n,
      armTx,
      drawnAtBlock: 13n,
      drawTx,
      finalisedAtBlock: 21n,
      finaliseTx,
    })
    expect(rounds[0]!.tickets[0]).to.deep.include({ commitTx, revealTx, revealedAtBlock: 14n })
  })
})
