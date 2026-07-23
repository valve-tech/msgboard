import { concatHex, keccak256, stringToHex, type Hex } from 'viem'
import { hashGameStateAbi } from './encoding'

// SETTLED belongs to the channel-level lifecycle (ChannelState.phase at cooperative settle);
// HiLoState transitions never produce it.
export enum Phase { SETUP = 0, DEAL = 1, BET_COMMIT = 2, BET_OPEN = 3, CALL_OR_FOLD = 4, SHOWDOWN = 5, FLIP_DONE = 6, SETTLED = 7 }
export type Seat = 'A' | 'B'
export type Bet = 'RAISE' | 'HOLD'

export interface HiLoState {
  phase: Phase
  deckIndex: number            // next undealt slot; this flip uses deckIndex (A) and deckIndex+1 (B)
  ante: bigint                 // ante for this flip, carried in state
  pot: bigint                  // this flip's pot (antes + raises); war carry lives in warPot until payout
  warPot: bigint               // carried from tied flips
  contributed: { A: bigint; B: bigint }
  commits: Partial<Record<Seat, Hex>>
  bets: Partial<Record<Seat, Bet>>
  raiser: Seat | null          // set when exactly one raised
  result: { winner: Seat; amount: bigint } | null
  foldedCardHidden: boolean    // true iff flip ended by fold (loser's card never revealed)
}

export type Move =
  | { kind: 'DEAL_DONE' }                                   // session layer attests both private deals completed
  | { kind: 'BET_COMMIT'; by: Seat; commitment: Hex }
  | { kind: 'BET_OPEN'; by: Seat; bet: Bet; salt: Hex }
  | { kind: 'CALL'; by: Seat }
  | { kind: 'FOLD'; by: Seat }
  | { kind: 'SHOWDOWN'; cardA: number; cardB: number }      // session layer supplies unmasked indices

export type MoveResult = { state: HiLoState } | { error: string }

export function hashBetCommit(bet: Bet, salt: Hex): Hex {
  return keccak256(concatHex([stringToHex(`hilo-war/bet/${bet}/`), salt]))
}

export function initialFlipState(args: { ante: bigint; deckIndex: number; warPot: bigint }): HiLoState {
  return {
    phase: Phase.DEAL, deckIndex: args.deckIndex, ante: args.ante, pot: 0n, warPot: args.warPot,
    contributed: { A: 0n, B: 0n }, commits: {}, bets: {}, raiser: null,
    result: null, foldedCardHidden: false,
  }
}

const rankOf = (i: number) => Math.floor(i / 4) + 2  // tiny local helper keeps rules dependency-free (mirrors zk-core cards.ts)

export function applyMove(s: HiLoState, m: Move): MoveResult {
  const err = (e: string): MoveResult => ({ error: `hilo-war: ${e}` })
  if (s.phase === Phase.FLIP_DONE || s.phase === Phase.SETTLED) return err('no moves on a terminal flip state')
  const ante = s.ante
  switch (m.kind) {
    case 'DEAL_DONE': {
      if (s.phase !== Phase.DEAL) return err(`DEAL_DONE in phase ${s.phase}`)
      return { state: { ...s, phase: Phase.BET_COMMIT, pot: 2n * ante, contributed: { A: ante, B: ante } } }
    }
    case 'BET_COMMIT': {
      if (s.phase !== Phase.BET_COMMIT) return err(`BET_COMMIT in phase ${s.phase}`)
      if (s.commits[m.by]) return err(`duplicate commit from ${m.by}`)
      const commits = { ...s.commits, [m.by]: m.commitment }
      const phase = commits.A && commits.B ? Phase.BET_OPEN : Phase.BET_COMMIT
      return { state: { ...s, commits, phase } }
    }
    case 'BET_OPEN': {
      if (s.phase !== Phase.BET_OPEN) return err(`BET_OPEN in phase ${s.phase}`)
      if (s.bets[m.by]) return err(`duplicate open from ${m.by}`)
      if (s.commits[m.by] !== hashBetCommit(m.bet, m.salt)) return err(`open does not match commitment from ${m.by}`)
      const bets = { ...s.bets, [m.by]: m.bet }
      let next: HiLoState = { ...s, bets }
      if (m.bet === 'RAISE') {
        const contributedBy = next.contributed[m.by] + ante
        next = {
          ...next,
          pot: next.pot + ante,
          contributed: m.by === 'A'
            ? { A: contributedBy, B: next.contributed.B }
            : { A: next.contributed.A, B: contributedBy },
        }
      }
      if (!(bets.A && bets.B)) return { state: next }
      if (bets.A === bets.B) return { state: { ...next, phase: Phase.SHOWDOWN, raiser: null } }
      const raiser: Seat = bets.A === 'RAISE' ? 'A' : 'B'
      return { state: { ...next, phase: Phase.CALL_OR_FOLD, raiser } }
    }
    case 'CALL': {
      if (s.phase !== Phase.CALL_OR_FOLD) return err(`CALL in phase ${s.phase}`)
      if (m.by === s.raiser) return err('raiser cannot call own raise')
      const contributedBy = s.contributed[m.by] + ante
      return { state: {
        ...s, phase: Phase.SHOWDOWN,
        pot: s.pot + ante,
        contributed: m.by === 'A'
          ? { A: contributedBy, B: s.contributed.B }
          : { A: s.contributed.A, B: contributedBy },
      } }
    }
    case 'FOLD': {
      if (s.phase !== Phase.CALL_OR_FOLD) return err(`FOLD in phase ${s.phase}`)
      if (m.by === s.raiser) return err('raiser cannot fold own raise')
      const winner = s.raiser!
      return { state: {
        ...s, phase: Phase.FLIP_DONE, foldedCardHidden: true,
        result: { winner, amount: s.pot + s.warPot }, warPot: 0n, pot: 0n,
      } }
    }
    case 'SHOWDOWN': {
      if (s.phase !== Phase.SHOWDOWN) return err(`SHOWDOWN in phase ${s.phase}`)
      if (!Number.isInteger(m.cardA) || m.cardA < 0 || m.cardA > 51) return err('card index out of range')
      if (!Number.isInteger(m.cardB) || m.cardB < 0 || m.cardB > 51) return err('card index out of range')
      if (m.cardA === m.cardB) return err('cards must be distinct')
      const ra = rankOf(m.cardA), rb = rankOf(m.cardB)
      if (ra === rb) {
        return { state: { ...s, phase: Phase.FLIP_DONE, result: null, warPot: s.warPot + s.pot, pot: 0n } }
      }
      const winner: Seat = ra > rb ? 'A' : 'B'
      return { state: { ...s, phase: Phase.FLIP_DONE, result: { winner, amount: s.pot + s.warPot }, warPot: 0n, pot: 0n } }
    }
  }
}

export function hashGameState(s: HiLoState): Hex {
  return hashGameStateAbi(s)
}
