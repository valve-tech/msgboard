import {
  concatHex, encodeAbiParameters, encodePacked, hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Hex,
} from 'viem'
import type { ChannelDomain, ChannelState, StateSigner } from './stateSig'

/**
 * EIP-712 "signed-intent relay" helpers for ZkTable's `*For` entrypoints (2026-08 pass): let a
 * gasless seat authorize `disputeSetup`/`openDispute`/`respondWithMove`/`reclaimTopUp`/`cancel`
 * via a signature instead of `msg.sender`, so any relayer can submit the tx on the seat's behalf.
 * Mirrors `stateSig.ts`'s ChannelState pattern exactly: same `ChannelDomain` ("ZkTable","1"),
 * same `StateSigner` interface, same hash/sign/verify shape — these intents are countersigned
 * with the SAME channel key that co-signs ChannelStates (the natural signer for a gasless seat),
 * over the SAME on-chain EIP-712 domain (see ZkTable.sol's `_hashTypedData` override).
 *
 * Every intent type here corresponds 1:1 to a Solidity typehash in ZkTable.sol (see the
 * "Signed-intent typehashes" section there) and a public `<name>IntentDigest(...)` view — the
 * Solidity<->viem parity test (`ZkChannelSig.test.ts`) asserts these two sides never drift.
 *
 * EXTENDED (2026-08) with HoldemTableN's own `*For` intent family — `start`/`registerDeckKey`/
 * `leaveBeforeStart`/`cancel`/`openDispute`/`respondWithMove` — under its own ("HoldemTableN","1")
 * domain (`IntentDomainN`, see below). Every HoldemTableN export carries an `N` suffix so it never
 * collides with ZkTable's identically-shaped exports above; both families reuse the SAME generic
 * `hashIntent`/`signIntent`/`verifyIntentSig` triad. Parity test: `ZkChannelNSig.test.ts`.
 */

// ── ChannelState struct-hash (pre-domain) ──────────────────────────────────────────────────────
// `OpenDisputeIntent.stateHash` binds the EXACT contested ChannelState via its own EIP-712 struct
// hash (ChannelStateLib.structHash on-chain) — NOT the full domain-wrapped digest `hashState`
// computes. This is that struct hash alone, so a signer can bind "this exact state" into the
// intent without a second domain-wrap.
const CHANNEL_STATE_TYPEHASH: Hex = keccak256(
  toHex(
    'ChannelState(bytes32 tableId,uint64 nonce,uint256 balanceA,uint256 balanceB,uint256 pot,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash,bytes32 jointKeyCommit,bytes32 shuffleRoot)',
  ),
)

export function channelStateStructHash(state: ChannelState): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        CHANNEL_STATE_TYPEHASH,
        state.tableId,
        state.nonce,
        state.balanceA,
        state.balanceB,
        state.pot,
        state.deckCommitment,
        state.phase,
        state.gameStateHash,
        state.jointKeyCommit,
        state.shuffleRoot,
      ],
    ),
  )
}

// ── generic hash/sign/verify over an arbitrary EIP-712 typed struct ───────────────────────────
type TypedDataTypes = Record<string, readonly { name: string; type: string }[]>

// Structural (not `ChannelDomain`-specific): both ZkTable's `ChannelDomain` ("ZkTable","1") and
// HoldemTableN's `IntentDomainN` ("HoldemTableN","1", declared below) satisfy this shape, so the
// same three generic helpers serve both tables' intent families without needing a shared nominal
// type across the two (kept deliberately separate — see IntentDomainN's own comment for why).
type IntentDomain = { name: string; version: string; chainId: number; verifyingContract: Hex }

// `message: object` (not Record<string, unknown>): the concrete intent interfaces below don't
// carry an implicit index signature, so they aren't assignable to Record<string, unknown>, but
// they ARE assignable to `object`. viem's typed-data calls take the fully-typed struct anyway
// (each helper casts to the viem arg shape internally), so this only loosens OUR wrapper boundary.
function hashIntent(domain: IntentDomain, types: TypedDataTypes, primaryType: string, message: object): Hex {
  return hashTypedData({ domain, types, primaryType, message } as any)
}

async function signIntent(
  signer: StateSigner,
  domain: IntentDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: object,
): Promise<Hex> {
  return signer.signTypedData({ domain, types, primaryType, message } as any)
}

async function verifyIntentSig(
  expected: Hex,
  domain: IntentDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: object,
  sig: Hex,
): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({ domain, types, primaryType, message: message as any, signature: sig })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch {
    return false
  }
}

// ── DisputeSetupIntent(bytes32 tableId,uint256 nonce,uint64 deadline) ──────────────────────────
export interface DisputeSetupIntent { tableId: Hex; nonce: bigint; deadline: bigint }
export const DISPUTE_SETUP_INTENT_TYPES = {
  DisputeSetupIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashDisputeSetupIntent = (domain: ChannelDomain, intent: DisputeSetupIntent): Hex =>
  hashIntent(domain, DISPUTE_SETUP_INTENT_TYPES, 'DisputeSetupIntent', intent)
export const signDisputeSetupIntent = (signer: StateSigner, domain: ChannelDomain, intent: DisputeSetupIntent): Promise<Hex> =>
  signIntent(signer, domain, DISPUTE_SETUP_INTENT_TYPES, 'DisputeSetupIntent', intent)
export const verifyDisputeSetupIntentSig = (
  expected: Hex, domain: ChannelDomain, intent: DisputeSetupIntent, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, DISPUTE_SETUP_INTENT_TYPES, 'DisputeSetupIntent', intent, sig)

// ── OpenDisputeIntent(bytes32 tableId,bytes32 stateHash,uint8 demandKind,uint32 demandSlot,uint256 nonce,uint64 deadline)
export interface OpenDisputeIntent {
  tableId: Hex; stateHash: Hex; demandKind: number; demandSlot: number; nonce: bigint; deadline: bigint
}
export const OPEN_DISPUTE_INTENT_TYPES = {
  OpenDisputeIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'stateHash', type: 'bytes32' },
    { name: 'demandKind', type: 'uint8' },
    { name: 'demandSlot', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashOpenDisputeIntent = (domain: ChannelDomain, intent: OpenDisputeIntent): Hex =>
  hashIntent(domain, OPEN_DISPUTE_INTENT_TYPES, 'OpenDisputeIntent', intent)
export const signOpenDisputeIntent = (signer: StateSigner, domain: ChannelDomain, intent: OpenDisputeIntent): Promise<Hex> =>
  signIntent(signer, domain, OPEN_DISPUTE_INTENT_TYPES, 'OpenDisputeIntent', intent)
export const verifyOpenDisputeIntentSig = (
  expected: Hex, domain: ChannelDomain, intent: OpenDisputeIntent, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, OPEN_DISPUTE_INTENT_TYPES, 'OpenDisputeIntent', intent, sig)

// ── RespondMoveIntent(bytes32 tableId,bytes32 gameStateHash,bytes32 moveHash,uint256 nonce,uint64 deadline)
export interface RespondMoveIntent { tableId: Hex; gameStateHash: Hex; moveHash: Hex; nonce: bigint; deadline: bigint }
export const RESPOND_MOVE_INTENT_TYPES = {
  RespondMoveIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'gameStateHash', type: 'bytes32' },
    { name: 'moveHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashRespondMoveIntent = (domain: ChannelDomain, intent: RespondMoveIntent): Hex =>
  hashIntent(domain, RESPOND_MOVE_INTENT_TYPES, 'RespondMoveIntent', intent)
export const signRespondMoveIntent = (signer: StateSigner, domain: ChannelDomain, intent: RespondMoveIntent): Promise<Hex> =>
  signIntent(signer, domain, RESPOND_MOVE_INTENT_TYPES, 'RespondMoveIntent', intent)
export const verifyRespondMoveIntentSig = (
  expected: Hex, domain: ChannelDomain, intent: RespondMoveIntent, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, RESPOND_MOVE_INTENT_TYPES, 'RespondMoveIntent', intent, sig)

// ── ReclaimTopUpIntent(bytes32 tableId,uint256 nonce,uint64 deadline) ──────────────────────────
export interface ReclaimTopUpIntent { tableId: Hex; nonce: bigint; deadline: bigint }
export const RECLAIM_TOPUP_INTENT_TYPES = {
  ReclaimTopUpIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashReclaimTopUpIntent = (domain: ChannelDomain, intent: ReclaimTopUpIntent): Hex =>
  hashIntent(domain, RECLAIM_TOPUP_INTENT_TYPES, 'ReclaimTopUpIntent', intent)
export const signReclaimTopUpIntent = (signer: StateSigner, domain: ChannelDomain, intent: ReclaimTopUpIntent): Promise<Hex> =>
  signIntent(signer, domain, RECLAIM_TOPUP_INTENT_TYPES, 'ReclaimTopUpIntent', intent)
export const verifyReclaimTopUpIntentSig = (
  expected: Hex, domain: ChannelDomain, intent: ReclaimTopUpIntent, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, RECLAIM_TOPUP_INTENT_TYPES, 'ReclaimTopUpIntent', intent, sig)

// ── CancelIntent(bytes32 tableId,uint256 nonce,uint64 deadline) — WALLET-ONLY signer ───────────
export interface CancelIntent { tableId: Hex; nonce: bigint; deadline: bigint }
export const CANCEL_INTENT_TYPES = {
  CancelIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashCancelIntent = (domain: ChannelDomain, intent: CancelIntent): Hex =>
  hashIntent(domain, CANCEL_INTENT_TYPES, 'CancelIntent', intent)
export const signCancelIntent = (signer: StateSigner, domain: ChannelDomain, intent: CancelIntent): Promise<Hex> =>
  signIntent(signer, domain, CANCEL_INTENT_TYPES, 'CancelIntent', intent)
export const verifyCancelIntentSig = (
  expected: Hex, domain: ChannelDomain, intent: CancelIntent, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, CANCEL_INTENT_TYPES, 'CancelIntent', intent, sig)

// ── ChallengeDeckIntent(bytes32 tableId,uint256 nonce,uint64 deadline) — gasless relay for
// ZkTable's `challengeDeckFor` (deckkey-binding wave-2 contract blueprint §3). Binds ONLY
// `tableId` — everything economically-relevant about the challenge (the transcript, the pinned
// pkc, the bond) is pinned by on-chain commitments (`disputeState.jointKeyCommit`/`shuffleRoot`),
// not by the intent itself, mirroring `CancelIntent`'s minimal shape.
export interface ChallengeDeckIntent { tableId: Hex; nonce: bigint; deadline: bigint }
export const CHALLENGE_DECK_INTENT_TYPES = {
  ChallengeDeckIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashChallengeDeckIntent = (domain: ChannelDomain, intent: ChallengeDeckIntent): Hex =>
  hashIntent(domain, CHALLENGE_DECK_INTENT_TYPES, 'ChallengeDeckIntent', intent)
export const signChallengeDeckIntent = (signer: StateSigner, domain: ChannelDomain, intent: ChallengeDeckIntent): Promise<Hex> =>
  signIntent(signer, domain, CHALLENGE_DECK_INTENT_TYPES, 'ChallengeDeckIntent', intent)
export const verifyChallengeDeckIntentSig = (
  expected: Hex, domain: ChannelDomain, intent: ChallengeDeckIntent, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, CHALLENGE_DECK_INTENT_TYPES, 'ChallengeDeckIntent', intent, sig)

// ════════════════════════════════════════════════════════════════════════════════════════════
// HoldemTableN (2026-08 pass): the N-party sibling's `*For` entrypoints — `start`/
// `registerDeckKey`/`leaveBeforeStart`/`cancel`/`openDispute`/`respondWithMove`. Every exported
// name below carries an `N` suffix (matching `@msgboard/holdem`'s `ChannelStateN`/`hashStateN`/
// `makeDomainN` convention) so it never collides with ZkTable's identically-shaped
// `RespondMoveIntent`/`CancelIntent`/etc. above in this same module. Domain is ("HoldemTableN","1")
// — see HoldemTableN.sol's `_hashTypedData` override — so an intent signed here can never be
// replayed against ZkTable (different domain separator) even where a struct's field list is
// byte-identical to one of ZkTable's own intents.
// ════════════════════════════════════════════════════════════════════════════════════════════

/// HoldemTableN's own EIP-712 domain shape: `{ name: 'HoldemTableN'; version: '1'; ... }`.
/// Deliberately a LOCAL, structural duplicate of `@msgboard/holdem`'s `ChannelDomainN`
/// (games/holdem/src/stateSigN.ts) rather than an import: `@msgboard/holdem` already depends on
/// `@msgboard/zk-cards-core` (this package), so importing the other way would be circular. Any
/// `ChannelDomainN` value from `@msgboard/holdem` is structurally assignable here (and vice
/// versa) — TypeScript duck-typing, no cast needed at call sites. Field-for-field parity with
/// holdem/src/stateSigN.ts and on-chain `_domainNameAndVersion` is enforced by the
/// Solidity<->viem parity test (`ZkChannelNSig.test.ts`), which imports BOTH packages.
export interface IntentDomainN { name: 'HoldemTableN'; version: '1'; chainId: number; verifyingContract: Hex }

export function makeIntentDomainN(chainId: number, verifyingContract: Hex): IntentDomainN {
  return { name: 'HoldemTableN', version: '1', chainId, verifyingContract }
}

// ── ChannelStateN struct-hash (pre-domain) ─────────────────────────────────────────────────────
// `OpenDisputeIntentN.stateHash` binds the EXACT contested ChannelStateN via its own EIP-712
// struct hash (`ChannelStateNLib.structHash` on-chain) — NOT the full domain-wrapped digest
// `hashStateN` computes. Mirrors `channelStateStructHash` above for ZkTable's 2-party
// ChannelState; duplicated (rather than imported from `@msgboard/holdem`) for the same
// circular-dependency reason as `IntentDomainN` above. `SidePotN`/`ChannelStateNShape` are
// structural mirrors of holdem's `SidePot`/`ChannelStateN` — any value of those types is
// assignable here without a cast.
export interface SidePotN { amount: bigint; eligibleMask: bigint }
export interface ChannelStateNShape {
  tableId: Hex
  nonce: bigint
  balances: bigint[]
  pot: bigint
  sidePots: SidePotN[]
  rakeAccrued: bigint
  deckCommitment: Hex
  phase: number
  gameStateHash: Hex
}

const CHANNEL_STATE_N_TYPEHASH: Hex = keccak256(
  toHex(
    'ChannelStateN(bytes32 tableId,uint64 nonce,uint256[] balances,uint256 pot,SidePot[] sidePots,uint256 rakeAccrued,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash)SidePot(uint256 amount,uint256 eligibleMask)',
  ),
)
const SIDEPOT_N_TYPEHASH: Hex = keccak256(toHex('SidePot(uint256 amount,uint256 eligibleMask)'))

/// keccak256(abi.encodePacked(balances)) — Solidity packs a `uint256[]` as its elements'
/// concatenated 32-byte words with NO length prefix (each `uint256` is already 32-byte aligned,
/// so packed-encoding == individually-encoded-and-concatenated here).
function _hashBalancesN(balances: bigint[]): Hex {
  if (balances.length === 0) return keccak256('0x')
  return keccak256(encodePacked(balances.map(() => 'uint256' as const), balances))
}

/// keccak256(bytes.concat(...each SidePot's own struct hash)) — mirrors
/// `ChannelStateNLib._hashSidePots` exactly.
function _hashSidePotsN(sidePots: SidePotN[]): Hex {
  if (sidePots.length === 0) return keccak256('0x')
  const parts = sidePots.map((sp) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
        [SIDEPOT_N_TYPEHASH, sp.amount, sp.eligibleMask],
      ),
    ),
  )
  return keccak256(concatHex(parts))
}

export function channelStateNStructHash(state: ChannelStateNShape): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'bytes32' },
      ],
      [
        CHANNEL_STATE_N_TYPEHASH,
        state.tableId,
        state.nonce,
        _hashBalancesN(state.balances),
        state.pot,
        _hashSidePotsN(state.sidePots),
        state.rakeAccrued,
        state.deckCommitment,
        state.phase,
        state.gameStateHash,
      ],
    ),
  )
}

// ── StartIntentN(bytes32 tableId,uint256 nonce,uint64 deadline) ───────────────────────────────
export interface StartIntentN { tableId: Hex; nonce: bigint; deadline: bigint }
export const START_INTENT_N_TYPES = {
  StartIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashStartIntentN = (domain: IntentDomainN, intent: StartIntentN): Hex =>
  hashIntent(domain, START_INTENT_N_TYPES, 'StartIntent', intent)
export const signStartIntentN = (signer: StateSigner, domain: IntentDomainN, intent: StartIntentN): Promise<Hex> =>
  signIntent(signer, domain, START_INTENT_N_TYPES, 'StartIntent', intent)
export const verifyStartIntentNSig = (
  expected: Hex, domain: IntentDomainN, intent: StartIntentN, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, START_INTENT_N_TYPES, 'StartIntent', intent, sig)

// ── RegisterDeckKeyIntentN(bytes32 tableId,uint256 pkX,uint256 pkY,uint256 nonce,uint64 deadline)
export interface RegisterDeckKeyIntentN { tableId: Hex; pkX: bigint; pkY: bigint; nonce: bigint; deadline: bigint }
export const REGISTER_DECK_KEY_INTENT_N_TYPES = {
  RegisterDeckKeyIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'pkX', type: 'uint256' },
    { name: 'pkY', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashRegisterDeckKeyIntentN = (domain: IntentDomainN, intent: RegisterDeckKeyIntentN): Hex =>
  hashIntent(domain, REGISTER_DECK_KEY_INTENT_N_TYPES, 'RegisterDeckKeyIntent', intent)
export const signRegisterDeckKeyIntentN = (
  signer: StateSigner, domain: IntentDomainN, intent: RegisterDeckKeyIntentN,
): Promise<Hex> => signIntent(signer, domain, REGISTER_DECK_KEY_INTENT_N_TYPES, 'RegisterDeckKeyIntent', intent)
export const verifyRegisterDeckKeyIntentNSig = (
  expected: Hex, domain: IntentDomainN, intent: RegisterDeckKeyIntentN, sig: Hex,
): Promise<boolean> =>
  verifyIntentSig(expected, domain, REGISTER_DECK_KEY_INTENT_N_TYPES, 'RegisterDeckKeyIntent', intent, sig)

// ── LeaveIntentN(bytes32 tableId,uint256 nonce,uint64 deadline) ───────────────────────────────
export interface LeaveIntentN { tableId: Hex; nonce: bigint; deadline: bigint }
export const LEAVE_INTENT_N_TYPES = {
  LeaveIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashLeaveIntentN = (domain: IntentDomainN, intent: LeaveIntentN): Hex =>
  hashIntent(domain, LEAVE_INTENT_N_TYPES, 'LeaveIntent', intent)
export const signLeaveIntentN = (signer: StateSigner, domain: IntentDomainN, intent: LeaveIntentN): Promise<Hex> =>
  signIntent(signer, domain, LEAVE_INTENT_N_TYPES, 'LeaveIntent', intent)
export const verifyLeaveIntentNSig = (
  expected: Hex, domain: IntentDomainN, intent: LeaveIntentN, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, LEAVE_INTENT_N_TYPES, 'LeaveIntent', intent, sig)

// ── CancelIntentN(bytes32 tableId,uint256 nonce,uint64 deadline) — WALLET-ONLY signer ──────────
export interface CancelIntentN { tableId: Hex; nonce: bigint; deadline: bigint }
export const CANCEL_INTENT_N_TYPES = {
  CancelIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashCancelIntentN = (domain: IntentDomainN, intent: CancelIntentN): Hex =>
  hashIntent(domain, CANCEL_INTENT_N_TYPES, 'CancelIntent', intent)
export const signCancelIntentN = (signer: StateSigner, domain: IntentDomainN, intent: CancelIntentN): Promise<Hex> =>
  signIntent(signer, domain, CANCEL_INTENT_N_TYPES, 'CancelIntent', intent)
export const verifyCancelIntentNSig = (
  expected: Hex, domain: IntentDomainN, intent: CancelIntentN, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, CANCEL_INTENT_N_TYPES, 'CancelIntent', intent, sig)

// ── OpenDisputeIntentN(bytes32 tableId,bytes32 stateHash,uint8 demandSeat,uint8 demandKind,uint32 demandSlot,uint256 nonce,uint64 deadline)
export interface OpenDisputeIntentN {
  tableId: Hex; stateHash: Hex; demandSeat: number; demandKind: number; demandSlot: number; nonce: bigint; deadline: bigint
}
export const OPEN_DISPUTE_INTENT_N_TYPES = {
  OpenDisputeIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'stateHash', type: 'bytes32' },
    { name: 'demandSeat', type: 'uint8' },
    { name: 'demandKind', type: 'uint8' },
    { name: 'demandSlot', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashOpenDisputeIntentN = (domain: IntentDomainN, intent: OpenDisputeIntentN): Hex =>
  hashIntent(domain, OPEN_DISPUTE_INTENT_N_TYPES, 'OpenDisputeIntent', intent)
export const signOpenDisputeIntentN = (signer: StateSigner, domain: IntentDomainN, intent: OpenDisputeIntentN): Promise<Hex> =>
  signIntent(signer, domain, OPEN_DISPUTE_INTENT_N_TYPES, 'OpenDisputeIntent', intent)
export const verifyOpenDisputeIntentNSig = (
  expected: Hex, domain: IntentDomainN, intent: OpenDisputeIntentN, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, OPEN_DISPUTE_INTENT_N_TYPES, 'OpenDisputeIntent', intent, sig)

// ── RespondMoveIntentN(bytes32 tableId,bytes32 gameStateHash,bytes32 moveHash,uint256 nonce,uint64 deadline)
export interface RespondMoveIntentN { tableId: Hex; gameStateHash: Hex; moveHash: Hex; nonce: bigint; deadline: bigint }
export const RESPOND_MOVE_INTENT_N_TYPES = {
  RespondMoveIntent: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'gameStateHash', type: 'bytes32' },
    { name: 'moveHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const hashRespondMoveIntentN = (domain: IntentDomainN, intent: RespondMoveIntentN): Hex =>
  hashIntent(domain, RESPOND_MOVE_INTENT_N_TYPES, 'RespondMoveIntent', intent)
export const signRespondMoveIntentN = (signer: StateSigner, domain: IntentDomainN, intent: RespondMoveIntentN): Promise<Hex> =>
  signIntent(signer, domain, RESPOND_MOVE_INTENT_N_TYPES, 'RespondMoveIntent', intent)
export const verifyRespondMoveIntentNSig = (
  expected: Hex, domain: IntentDomainN, intent: RespondMoveIntentN, sig: Hex,
): Promise<boolean> => verifyIntentSig(expected, domain, RESPOND_MOVE_INTENT_N_TYPES, 'RespondMoveIntent', intent, sig)
