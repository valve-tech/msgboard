/**
 * boardProtocol.ts — the wire contract for a split-key board session.
 *
 * One shared MsgBoard category carries every message for a chain's tables. Both the house service
 * and every browser player bind a transport to `houseCategory(chainId)`. Messages are tagged by
 * `tableId` (open/round) or by `reqId = tableId:nonce` (the co-sign halves, defined in
 * @msgboard/games/boardCoSign). Each consumer acts ONLY on the kinds the OTHER party sends, so
 * a transport reading its own echoed posts is harmless:
 *
 *   player → house : open-request, round-request, cosign-rep
 *   house  → player: open-grant, open-decline, round-transcript, round-decline, cosign-req
 *
 * Because the sets are disjoint by sender, self-echo never triggers an action. Cross-table messages
 * on the shared category are filtered by `tableId` (open/round here, and by reqId in boardCoSign).
 *
 * SECURITY: the open-grant carries ONLY {terms, houseSig} — never the house seed chain. Revealing
 * the server seed before the player commits its clientSeed would let the player grind clientSeed
 * against a known serverSeed to bias the roll (the mirror of the house-side grind). The seed is
 * revealed only inside the co-signed ROUND envelope, after rngCommit is fixed on-chain.
 */
import type { Hex } from 'viem'
import type { OpenTerms } from './openTerms'

/** The single shared category all session-protocol traffic for a chain flows over. */
export function houseCategory(chainId: number): { category: string } {
  return { category: `games.msgboard.xyz:house:${chainId}` }
}

// ── message shapes ────────────────────────────────────────────────────────────

/**
 * Player → house. Carries everything the house needs to size escrow and sign OpenTerms, plus the
 * clientSeed COMMIT (never the plaintext seed). The house builds its server seed chain blind from
 * this, so it cannot grind its tip against a known clientSeed.
 */
export interface OpenRequestMsg {
  kind: 'open-request'
  tableId: Hex
  player: Hex
  playerKey: Hex
  gameId: number
  /** Raw game params for `gameId` (bigints survive the board codec). The house routes by gameId and
   *  re-derives escrow via that game's maxMultiplierX100(params) — never trusting a player-sent cap. */
  params: unknown
  stake: bigint
  /** keccak256(clientSeed). The plaintext seed is revealed only at round time. */
  clientSeedCommit: Hex
}

/** House → player. The house-signed OpenTerms (terms.rngCommit is the house's blind chain head). */
export interface OpenGrantMsg {
  kind: 'open-grant'
  tableId: Hex
  terms: OpenTerms
  houseSig: Hex
}

/** House → player. The house refused to open (e.g. escrow over cap). */
export interface OpenDeclineMsg {
  kind: 'open-decline'
  tableId: Hex
  reason: string
}

/**
 * Player → house. Reveals the plaintext clientSeed (the house verifies it against the stored
 * clientSeedCommit before co-signing) plus the round's stake/params.
 */
export interface RoundRequestMsg {
  kind: 'round-request'
  tableId: Hex
  clientSeed: Hex
  stake: bigint
  params: unknown
  playerAddress: Hex
  playerKey: Hex
}

/** House → player. The finished, doubly-co-signed transcript JSON for the round. */
export interface RoundTranscriptMsg {
  kind: 'round-transcript'
  tableId: Hex
  transcriptJson: string
}

/** House → player. The house refused the round (e.g. clientSeed reveal mismatch). */
export interface RoundDeclineMsg {
  kind: 'round-decline'
  tableId: Hex
  reason: string
}

// ── type guards ───────────────────────────────────────────────────────────────

const isKind = (m: unknown, k: string): m is { kind: string; tableId: Hex } =>
  !!m && typeof m === 'object' && (m as { kind?: unknown }).kind === k &&
  typeof (m as { tableId?: unknown }).tableId === 'string'

export const isOpenRequest = (m: unknown): m is OpenRequestMsg => isKind(m, 'open-request')
export const isOpenGrant = (m: unknown): m is OpenGrantMsg => isKind(m, 'open-grant')
export const isOpenDecline = (m: unknown): m is OpenDeclineMsg => isKind(m, 'open-decline')
export const isRoundRequest = (m: unknown): m is RoundRequestMsg => isKind(m, 'round-request')
export const isRoundTranscript = (m: unknown): m is RoundTranscriptMsg => isKind(m, 'round-transcript')
export const isRoundDecline = (m: unknown): m is RoundDeclineMsg => isKind(m, 'round-decline')

/** Same-table filter for open/round messages on the shared category (case-insensitive hex). */
export const sameTable = (a: Hex, b: Hex): boolean => a.toLowerCase() === b.toLowerCase()
