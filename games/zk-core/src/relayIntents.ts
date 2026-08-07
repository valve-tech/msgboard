import {
  encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Hex,
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
 */

// ── ChannelState struct-hash (pre-domain) ──────────────────────────────────────────────────────
// `OpenDisputeIntent.stateHash` binds the EXACT contested ChannelState via its own EIP-712 struct
// hash (ChannelStateLib.structHash on-chain) — NOT the full domain-wrapped digest `hashState`
// computes. This is that struct hash alone, so a signer can bind "this exact state" into the
// intent without a second domain-wrap.
const CHANNEL_STATE_TYPEHASH: Hex = keccak256(
  toHex(
    'ChannelState(bytes32 tableId,uint64 nonce,uint256 balanceA,uint256 balanceB,uint256 pot,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash)',
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
      ],
    ),
  )
}

// ── generic hash/sign/verify over an arbitrary EIP-712 typed struct ───────────────────────────
type TypedDataTypes = Record<string, readonly { name: string; type: string }[]>

// `message: object` (not Record<string, unknown>): the concrete intent interfaces below don't
// carry an implicit index signature, so they aren't assignable to Record<string, unknown>, but
// they ARE assignable to `object`. viem's typed-data calls take the fully-typed struct anyway
// (each helper casts to the viem arg shape internally), so this only loosens OUR wrapper boundary.
function hashIntent(domain: ChannelDomain, types: TypedDataTypes, primaryType: string, message: object): Hex {
  return hashTypedData({ domain, types, primaryType, message } as any)
}

async function signIntent(
  signer: StateSigner,
  domain: ChannelDomain,
  types: TypedDataTypes,
  primaryType: string,
  message: object,
): Promise<Hex> {
  return signer.signTypedData({ domain, types, primaryType, message } as any)
}

async function verifyIntentSig(
  expected: Hex,
  domain: ChannelDomain,
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
