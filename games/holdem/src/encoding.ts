import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { Phase, type HoldemState, type Move } from './rules'
import type { ChannelStateN } from './stateSigN'

/// Convert an ascending eligible-seat list to the uint256 bitmask the contract uses (bit i
/// set => seat i eligible), and back. The channel's SidePot already speaks the mask form, so
/// the on-chain side keeps masks while the TS rules keep the index list.
export function eligibleToMask(eligible: number[]): bigint {
  let m = 0n
  for (const i of eligible) m |= 1n << BigInt(i)
  return m
}
export function maskToEligible(mask: bigint, nSeats: number): number[] {
  const out: number[] = []
  for (let i = 0; i < nSeats; i++) if ((mask >> BigInt(i)) & 1n) out.push(i)
  return out
}

/// Bridge a SETTLED HoldemState into the channel's ChannelStateN settle state the on-chain
/// HoldemTableN.settle verifies. The carry-forward: HoldemState's per-seat `stacks` become the
/// channel `balances` vector; the showdown zeroed `pot`/`sidePots` (settle requires both empty);
/// `rakeAccrued` carries the rake. `eligible:number[]` → `eligibleMask:bigint` is handled here
/// for any residual side pots (none after a showdown — empty by construction). The conservation
/// invariant Σ balances + pot(0) + Σ sidePots(0) + rakeAccrued == Σ escrow holds by construction.
export function toChannelSettleState(
  s: HoldemState,
  args: { tableId: Hex; nonce: bigint; deckCommitment: Hex },
): ChannelStateN {
  return {
    tableId: args.tableId,
    nonce: args.nonce,
    balances: [...s.stacks],
    pot: s.pot,
    sidePots: s.sidePots.map((p) => ({ amount: p.amount, eligibleMask: eligibleToMask(p.eligible) })),
    rakeAccrued: s.rakeAccrued,
    deckCommitment: args.deckCommitment,
    phase: s.phase,
    gameStateHash: hashGameState(s),
  }
}

/// Canonical game-state tuple — order is consensus, mirrored field-for-field by
/// HoldemRules.sol's `Holdem` struct. The whole state is ONE `tuple` parameter so its
/// encoding matches Solidity `abi.decode(bytes, (Holdem))` byte-for-byte (a dynamic struct
/// at the top level carries a leading offset; a flat parameter list would not). Dynamic
/// arrays (stacks/committed/totalContributed/folded/allIn/actedSinceAggression) and the
/// SidePot[] are the parity-bug-prone part.
export const GAME_STATE_TUPLE = {
  type: 'tuple',
  components: [
    { type: 'uint8' }, // phase
    { type: 'uint8' }, // nSeats
    { type: 'uint8' }, // button
    { type: 'uint8' }, // toAct (0xff = none / -1)
    { type: 'uint256[]' }, // stacks
    { type: 'uint256[]' }, // committed
    { type: 'uint256[]' }, // totalContributed
    { type: 'bool[]' }, // folded
    { type: 'bool[]' }, // allIn
    { type: 'bool[]' }, // actedSinceAggression
    { type: 'uint256' }, // currentBet
    { type: 'uint256' }, // minRaise
    { type: 'uint8' }, // lastAggressor (0xff = none / -1)
    { type: 'uint256' }, // pot
    { type: 'tuple[]', components: [{ type: 'uint256' }, { type: 'uint256' }] }, // sidePots (amount, eligibleMask)
    { type: 'uint256' }, // smallBlind
    { type: 'uint256' }, // bigBlind
    { type: 'uint16' }, // rakeBps
    { type: 'uint256' }, // rakeCap
    { type: 'uint8' }, // stubWinner (0xff = none / -1)
    { type: 'uint256' }, // rakeAccrued (Task 7; 0 until SETTLED)
  ],
} as const

const u8 = (n: number): number => (n < 0 ? 0xff : n)

export function encodeGameState(s: HoldemState): Hex {
  return encodeAbiParameters([GAME_STATE_TUPLE] as any, [
    [
      s.phase,
      s.nSeats,
      s.button,
      u8(s.toAct),
      s.stacks,
      s.committed,
      s.totalContributed,
      s.folded,
      s.allIn,
      s.actedSinceAggression,
      s.currentBet,
      s.minRaise,
      u8(s.lastAggressor),
      s.pot,
      s.sidePots.map((p) => [p.amount, eligibleToMask(p.eligible)]),
      s.smallBlind,
      s.bigBlind,
      s.rakeBps,
      s.rakeCap,
      u8(s.stubWinner),
      s.rakeAccrued,
    ],
  ])
}

export function hashGameState(s: HoldemState): Hex {
  return keccak256(encodeGameState(s))
}

/// Move encoding. `kind` is a numeric tag; the payload is a flat tuple per kind.
export const MOVE_KIND = {
  POST_BLIND: 0,
  CHECK: 1,
  CALL: 2,
  FOLD: 3,
  BET: 4,
  RAISE: 5,
  DEAL_DONE: 6,
  SHOWDOWN: 7,
} as const

export function encodeMove(m: Move): Hex {
  const payload = ((): Hex => {
    switch (m.kind) {
      case 'POST_BLIND':
        return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [m.seat, m.amount])
      case 'CHECK':
      case 'CALL':
      case 'FOLD':
        return encodeAbiParameters([{ type: 'uint8' }], [m.seat])
      case 'BET':
      case 'RAISE':
        return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [m.seat, m.to])
      case 'DEAL_DONE':
        return encodeAbiParameters([{ type: 'uint8' }], [m.phase])
      case 'SHOWDOWN':
        // holes: per-seat [hole0, hole1] (uint8[2][]); board: 5 community indices (uint8[5]).
        return encodeAbiParameters(
          [{ type: 'uint8[2][]' }, { type: 'uint8[5]' }],
          [m.holes.map((h) => [h[0]!, h[1]!]) as any, m.board as any],
        )
    }
  })()
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [MOVE_KIND[m.kind], payload])
}

/// Bitmask of seats that owe the next action (bit i => seat i) — mirrors HoldemRules.whoseTurn.
/// In a BET_* phase exactly the single `toAct` seat owes; in a DEAL_* phase every live seat
/// owes board progress; SHOWDOWN/SETTLED owe nobody (settled by the channel).
export function whoseTurn(s: HoldemState): bigint {
  if (
    s.phase === Phase.BET_PREFLOP ||
    s.phase === Phase.BET_FLOP ||
    s.phase === Phase.BET_TURN ||
    s.phase === Phase.BET_RIVER
  ) {
    return s.toAct >= 0 ? 1n << BigInt(s.toAct) : 0n
  }
  if (s.phase === Phase.SHOWDOWN || s.phase === Phase.SETTLED) return 0n
  // SETUP/SHUFFLE/DEAL_*: every non-folded seat owes protocol progress.
  let mask = 0n
  for (let i = 0; i < s.nSeats; i++) if (!s.folded[i]) mask |= 1n << BigInt(i)
  return mask
}
