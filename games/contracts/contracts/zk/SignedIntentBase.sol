// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";

/// @notice Shared "signed-intent relay" primitive for state-channel card tables: lets a gasless
/// seat authorize an action via an EIP-712 signature instead of `msg.sender`, so a relayer (bot,
/// paymaster, watchtower — anyone, no special permission) can submit the tx on the seat's behalf.
/// Extracted so BOTH ZkTable and its future HoldemTableN counterpart share exactly ONE
/// implementation of the nonce/deadline/recover logic — see ChannelTableBase's header for why the
/// two tables otherwise stay separate contracts; this is the same "de-duplicate the identical
/// bits, keep the different bits apart" rationale.
///
/// Holds exactly one piece of storage (`relayNonces`) — this is the ONE new storage slot the
/// signed-intent feature needs; everything else (dispute machinery, escrow, ChannelState) is
/// untouched. `is SignedIntentBase` therefore does append one new mapping slot to whatever
/// inherits it (unlike ChannelTableBase, which is storage-free) — acceptable here because ZkTable
/// is undeployed (no live storage layout to preserve).
///
/// SECURITY MODEL — the #1 risk this closes is a relayer IMPERSONATING a seat. `_consumeIntent`
/// never trusts a caller-supplied "signer" argument: it always RECOVERS the signer from the
/// signature itself (`ECDSA.recoverCalldata`, which reverts on a malformed/invalid signature
/// rather than ever returning a wrong-but-plausible address), so a relayer can relay an intent
/// completely unmodified, or not at all — it can never redirect an intent to a different
/// identity, forge one for a seat it doesn't hold the key for, or tamper with any field bound
/// into `structHash` without invalidating the recovered signer (which then fails the calling
/// contract's own identity check — e.g. ZkTable's `_seatOf` — long before any fund movement).
/// Every intent-consuming entrypoint MUST feed `_consumeIntent`'s recovered `signer` into the
/// SAME identity resolution a direct caller would go through (never a caller-supplied seat/
/// address), and every payout destination MUST stay keyed to the table's stored player
/// addresses (never the relayer, never a raw `msg.sender`).
abstract contract SignedIntentBase {
    /// The intent's `deadline` has passed (`block.timestamp > deadline`).
    error IntentExpired();
    /// The recovered signer's next expected nonce does not match the intent's `nonce` — either a
    /// replay of an already-consumed intent, or a not-yet-reachable nonce submitted out of order.
    error BadNonce();

    /// A signed intent was verified and consumed (nonce burned). `signer` is the RECOVERED
    /// address (never a caller-supplied one) — off-chain indexers can use this to attribute the
    /// action to the real seat even though the transaction's `msg.sender` was a relayer.
    event IntentConsumed(address indexed signer, uint256 nonce);

    /// Per-signer, strictly sequential relay nonce. Shared across every intent TYPE for a given
    /// signer on a given contract (not per-table, not per-intent-kind) — simplest possible replay
    /// model: each signer's intents form one global, gapless queue. A signer with seats at
    /// multiple tables, or issuing different kinds of intents, must sequence them itself
    /// (exactly like an EOA's transaction nonce), which is straightforward for a client that is
    /// already the sole author of everything it signs.
    mapping(address => uint256) public relayNonces;

    /// Implemented by the concrete contract's own Solady `EIP712` base (`_hashTypedData` is
    /// declared `internal view virtual` there with a full implementation) — declaring it again
    /// here, unimplemented, lets `_consumeIntent` below call it without SignedIntentBase itself
    /// knowing anything about the concrete contract's EIP-712 domain. The concrete contract (e.g.
    /// ZkTable) must resolve the diamond by overriding `_hashTypedData` and delegating to
    /// `EIP712._hashTypedData` explicitly — see ZkTable.sol's override for the exact wiring.
    function _hashTypedData(bytes32 structHash) internal view virtual returns (bytes32);

    /// Verifies `sig` over `structHash` (wrapped in the concrete contract's own EIP-712 domain —
    /// see `_hashTypedData` above, which is what makes this replay-safe ACROSS chains and
    /// contracts, not just across nonces), checks `deadline`, enforces the signer's strictly
    /// sequential nonce, and burns it. Reverts (never returns a "failure" sentinel) on every
    /// failure mode: `IntentExpired`, a malformed/invalid signature (Solady `ECDSA.
    /// recoverCalldata`'s own `InvalidSignature`), or `BadNonce`. This is the single place every
    /// `*For` entrypoint in every derived contract must route through — see the contract header's
    /// security model.
    function _consumeIntent(bytes32 structHash, uint256 nonce, uint64 deadline, bytes calldata sig)
        internal
        returns (address signer)
    {
        if (block.timestamp > deadline) revert IntentExpired();
        signer = ECDSA.recoverCalldata(_hashTypedData(structHash), sig); // reverts on bad sig
        if (nonce != relayNonces[signer]) revert BadNonce();
        unchecked {
            relayNonces[signer] = nonce + 1;
        }
        emit IntentConsumed(signer, nonce);
    }
}
