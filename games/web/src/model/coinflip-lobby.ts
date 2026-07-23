import * as viem from 'viem'
import { coinflip } from '@msgboard/coinflip'

/** Log provenance carried on every event so the UI can prove where each fact came from. */
export type EventMeta = { blockNumber?: bigint; transactionHash?: viem.Hex }

/** Decoded event args the lobby derivation consumes — plain data, no clients. */
export type CoinFlipEvents = {
  entered: ({ id: bigint; player: viem.Hex; side: number | 'heads' | 'tails'; stake: bigint; subsetHash: viem.Hex } & EventMeta)[]
  cancelled: { id: bigint }[]
  paired: ({ flipId: viem.Hex; heads: viem.Hex; tails: viem.Hex; stake: bigint } & EventMeta)[]
  heated: { flipId: viem.Hex; key: viem.Hex }[]
  settled: ({ flipId: viem.Hex; winner: viem.Hex; winningSide: number | 'heads' | 'tails'; payout: bigint; seed: viem.Hex } & EventMeta)[]
}

export type OpenEntry = {
  id: bigint
  player: viem.Hex
  side: 'heads' | 'tails'
  stake: bigint
  subsetHash: viem.Hex
  mine: boolean
  enteredAtBlock?: bigint
  enterTx?: viem.Hex
}

export type FlipView = {
  flipId: viem.Hex
  heads: viem.Hex
  tails: viem.Hex
  stake: bigint
  key?: viem.Hex
  status: 'pending' | 'settled'
  winner?: viem.Hex
  winningSide?: 'heads' | 'tails'
  payout?: bigint
  seed?: viem.Hex
  mine: boolean
  /** The pinned validator subset's hash, recovered from the consumed entries. */
  subsetHash?: viem.Hex
  pairedAtBlock?: bigint
  pairTx?: viem.Hex
  settledAtBlock?: bigint
  settleTx?: viem.Hex
}

export type CoinFlipLobby = { openEntries: OpenEntry[]; flips: FlipView[] }

const sameAddress = (a: viem.Hex, b: viem.Hex) => a.toLowerCase() === b.toLowerCase()

/**
 * Derive the lobby from raw events. Pairing consumption mirrors the contract's first-in-first-out
 * queue: each Paired event consumes, per side, the EARLIEST still-open entry matching that side's
 * player at the paired stake. Sides decode through the game's own decodeEntry — no local rule.
 */
export const deriveCoinFlipLobby = (events: CoinFlipEvents, myAddress?: viem.Hex): CoinFlipLobby => {
  const cancelled = new Set(events.cancelled.map((c) => c.id))
  const open = events.entered
    .filter((e) => !cancelled.has(e.id))
    .map((e) => ({ ...e, ...coinflip.decodeEntry(e) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))

  const consumed = new Set<bigint>()
  const subsetByFlip = new Map<viem.Hex, viem.Hex>()
  for (const pair of events.paired) {
    for (const [player, side] of [
      [pair.heads, 'heads'],
      [pair.tails, 'tails'],
    ] as const) {
      const match = open.find(
        (e) => !consumed.has(e.id) && e.side === side && e.stake === pair.stake && sameAddress(e.player, player),
      )
      if (match) {
        consumed.add(match.id)
        subsetByFlip.set(pair.flipId, match.subsetHash) // both sides share it — the contract only pairs equal hashes
      }
    }
  }

  const keyByFlip = new Map(events.heated.map((h) => [h.flipId, h.key]))
  const settledByFlip = new Map(events.settled.map((s) => [s.flipId, s]))
  const flips: FlipView[] = events.paired.map((pair) => {
    const settled = settledByFlip.get(pair.flipId)
    return {
      flipId: pair.flipId,
      heads: pair.heads,
      tails: pair.tails,
      stake: pair.stake,
      key: keyByFlip.get(pair.flipId),
      status: settled ? 'settled' : 'pending',
      winner: settled?.winner,
      winningSide: settled ? coinflip.decodeEntry({ player: settled.winner, side: settled.winningSide }).side : undefined,
      payout: settled?.payout,
      seed: settled?.seed,
      mine: myAddress !== undefined && (sameAddress(pair.heads, myAddress) || sameAddress(pair.tails, myAddress)),
      subsetHash: subsetByFlip.get(pair.flipId),
      pairedAtBlock: pair.blockNumber,
      pairTx: pair.transactionHash,
      settledAtBlock: settled?.blockNumber,
      settleTx: settled?.transactionHash,
    }
  })

  return {
    openEntries: open
      .filter((e) => !consumed.has(e.id))
      .map((e) => ({
        id: e.id,
        player: e.player,
        side: e.side,
        stake: e.stake,
        subsetHash: e.subsetHash,
        mine: myAddress !== undefined && sameAddress(e.player, myAddress),
        enteredAtBlock: e.blockNumber,
        enterTx: e.transactionHash,
      })),
    flips,
  }
}
