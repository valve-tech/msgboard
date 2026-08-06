// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";

/// @notice Shared error set, lifecycle `Status`, dispute-clock constants, and small
/// validation helpers common to BOTH state-channel card tables (ZkTable: fixed 2-party;
/// HoldemTableN: 3-9 seats, N=2 included). Extracted to de-duplicate their near-identical
/// external surface — create/join/cancel/settle/stateDigest/openDispute/respondWithState/
/// respondWithMove/respondWithShare/resolveTimeout — which previously re-declared the same 18
/// errors, the same 6-state lifecycle enum, and the same dispute-clock constants verbatim in
/// both files, and re-implemented the same one-line guards inline in each.
///
/// Holds NO storage: it exists purely for its errors, `Status` enum, constants, and pure/view
/// helpers, so `is ChannelTableBase` does not shift either derived contract's own storage
/// layout (moot anyway — both are undeployed — but kept clean regardless).
///
/// What is deliberately NOT here, and why: the escrow shape (ZkTable: two fixed uint256s vs
/// HoldemTableN: a per-seat uint256[] plus a treasury rake cut) and the co-signed-state type
/// itself (ChannelState's fixed balanceA/balanceB vs ChannelStateN's dynamic balances[]/
/// sidePots[]) are genuinely different data shapes, not incidentally-duplicated code. Unifying
/// them would mean rewriting ZkTable onto ChannelStateN — a different EIP-712 type hash — which
/// would break wire compatibility with the real off-chain gibs/zk-cards-core signer that
/// ZkTable's ChannelState mirrors byte-for-byte (games/zk-core/src/stateSig.ts). That migration
/// was evaluated during the 2026-08 DRY pass and deliberately NOT done; see that pass's report
/// for the full reasoning. `_checkCoSigned` therefore stays a separate, small implementation in
/// each contract — it composes the helpers below (`_validateTableId`, `_validateConservation`,
/// `_validateSig`) rather than being itself extracted.
abstract contract ChannelTableBase {
    // ── shared errors — identical name across ZkTable and HoldemTableN ──────────────────────
    error WrongValue();
    error BadClock();
    error BadStatus();
    error NotPlayer();
    error WrongTable();
    error BadSig();
    error NotFinal();
    error PotNotZero();
    error ConservationViolated();
    error StaleNonce();
    error BadRules();
    error ClockNotExpired();
    error NotYourDispute();
    error NotDemanded();
    error NotYourTurn();
    error BadGameState();
    error BadDemand();
    error BadDeck();

    /// Shared lifecycle status. Slot 1 is ZkTable's "Created" (escrowed, awaiting playerB's
    /// join) and HoldemTableN's "Forming" (escrowed, awaiting more seats / start()) — the same
    /// state under two names; the enum keeps ZkTable's original label since more call sites
    /// reference it. Enum member names are source/ABI-metadata only (no runtime encoding), so
    /// this is purely a naming choice, not a behavioral one.
    enum Status { None, Created, Live, Disputed, Settled, Cancelled }

    // ── shared dispute-machine constants ─────────────────────────────────────────────────────
    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;
    /// ZkTable-only (2-party) demand: a binding on-chain card-reveal showdown settlement — see
    /// ZkTable's showdown machinery (postShowdownReveals + finalizeShowdown, with the answer-aware
    /// resolveTimeout branch). Not accepted by `_validateDemandKind` (HoldemTableN has no showdown
    /// adjudication yet); ZkTable.openDispute validates it separately.
    uint8 internal constant DEMAND_SHOWDOWN = 3;
    uint64 public constant MIN_CLOCK_BLOCKS = 30;     // ~5 min at 10s blocks
    uint64 public constant MAX_CLOCK_BLOCKS = 60480;  // ~1 week

    /// create()'s clock-bound guard.
    function _validateClock(uint64 clockBlocks) internal pure {
        if (clockBlocks < MIN_CLOCK_BLOCKS || clockBlocks > MAX_CLOCK_BLOCKS) revert BadClock();
    }

    /// create()'s "rules contract must actually be deployed" guard — a dead rules address
    /// would brick settle for every seat.
    function _validateRulesCode(address rules) internal view {
        if (rules.code.length == 0) revert BadRules();
    }

    /// openDispute's demand-kind guard.
    function _validateDemandKind(uint8 demandKind) internal pure {
        if (demandKind != DEMAND_MOVE && demandKind != DEMAND_SHARE) revert BadDemand();
    }

    /// resolveTimeout's clock-expired guard.
    function _validateClockExpired(uint64 deadline) internal view {
        if (uint64(block.number) <= deadline) revert ClockNotExpired();
    }

    /// Co-signed-state guard: the state must be pinned to the table it is submitted against.
    function _validateTableId(bytes32 stateTableId, bytes32 tableId) internal pure {
        if (stateTableId != tableId) revert WrongTable();
    }

    /// Co-signed-state guard: the state's locked total must equal the table's current escrow —
    /// so dispute timeouts always pay out exactly the live escrow and a pre-top-up state
    /// becomes unsubmittable the instant a top-up lands.
    function _validateConservation(uint256 locked, uint256 escrowSum) internal pure {
        if (locked != escrowSum) revert ConservationViolated();
    }

    /// One signer's recovered key must match the expected channel key for its seat.
    /// Solady ECDSA does not enforce low-s; sigs are never used as identifiers here (replay
    /// safety = status + tableId pin + nonce checkpoint), so malleability is benign — do not
    /// use sig bytes as dedup keys off-chain.
    function _validateSig(bytes32 digest, bytes calldata sig, address key) internal view {
        if (ECDSA.recoverCalldata(digest, sig) != key) revert BadSig();
    }
}
