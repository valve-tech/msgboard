import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import type { HiLoState, Move, Seat, Bet } from './rules'

/** Canonical numeric codes shared with HiLoWarRules.sol — order is consensus. */
export const SEAT: Record<Seat, number> = { A: 1, B: 2 }
export const BET: Record<Bet, number> = { RAISE: 1, HOLD: 2 }
const ZERO32 = `0x${'00'.repeat(32)}` as Hex

// Tuple type, order is law — mirrors HiLoWarRules.sol exactly.
// (uint8 phase, uint32 deckIndex, uint256 ante, uint256 pot, uint256 warPot,
//  uint256 contributedA, uint256 contributedB, bytes32 commitA, bytes32 commitB,
//  uint8 betA, uint8 betB, uint8 raiser, uint8 resultWinner,
//  uint256 resultAmount, bool resultSet, bool foldedCardHidden)
export const GAME_STATE_ABI = [
  { type: 'uint8' },   // phase
  { type: 'uint32' },  // deckIndex
  { type: 'uint256' }, // ante
  { type: 'uint256' }, // pot
  { type: 'uint256' }, // warPot
  { type: 'uint256' }, // contributedA
  { type: 'uint256' }, // contributedB
  { type: 'bytes32' }, // commitA (0 = absent)
  { type: 'bytes32' }, // commitB
  { type: 'uint8' },   // betA (0 none / 1 RAISE / 2 HOLD)
  { type: 'uint8' },   // betB
  { type: 'uint8' },   // raiser (0 none / 1 A / 2 B)
  { type: 'uint8' },   // resultWinner (0 none / 1 A / 2 B)
  { type: 'uint256' }, // resultAmount
  { type: 'bool' },    // resultSet (false encodes result: null)
  { type: 'bool' },    // foldedCardHidden
] as const

export function encodeGameState(s: HiLoState): Hex {
  // `as any`: TS cannot infer GAME_STATE_ABI's 16-tuple against viem's AbiParametersToPrimitiveTypes without a verbose explicit annotation; runtime values are correct per the ABI comment above.
  return encodeAbiParameters(GAME_STATE_ABI as any, [
    s.phase, s.deckIndex, s.ante, s.pot, s.warPot,
    s.contributed.A, s.contributed.B,
    s.commits.A ?? ZERO32, s.commits.B ?? ZERO32,
    s.bets.A ? BET[s.bets.A] : 0, s.bets.B ? BET[s.bets.B] : 0,
    s.raiser ? SEAT[s.raiser] : 0,
    s.result ? SEAT[s.result.winner] : 0, s.result?.amount ?? 0n, s.result !== null,
    s.foldedCardHidden,
  ])
}

export function hashGameStateAbi(s: HiLoState): Hex {
  return keccak256(encodeGameState(s))
}

export const MOVE_KIND = { DEAL_DONE: 0, BET_COMMIT: 1, BET_OPEN: 2, CALL: 3, FOLD: 4, SHOWDOWN: 5 } as const

export function encodeMove(m: Move): Hex {
  const payload = (() => {
    switch (m.kind) {
      case 'DEAL_DONE': return '0x' as Hex
      case 'BET_COMMIT': return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }], [SEAT[m.by], m.commitment])
      case 'BET_OPEN': return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }, { type: 'bytes32' }], [SEAT[m.by], BET[m.bet], m.salt])
      case 'CALL': return encodeAbiParameters([{ type: 'uint8' }], [SEAT[m.by]])
      case 'FOLD': return encodeAbiParameters([{ type: 'uint8' }], [SEAT[m.by]])
      case 'SHOWDOWN': return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }], [m.cardA, m.cardB])
    }
  })()
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [MOVE_KIND[m.kind], payload])
}
