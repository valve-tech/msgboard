// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ZkTable} from "../zk/ZkTable.sol";
import {ChannelState} from "../zk/ChannelState.sol";
import {IX402Token} from "../games/FlipBookX.sol";

/// @notice TEST-ONLY harness: lets the decoy-deck-challenge Foundry suites (ZkTableDecoyChallenge
/// .t.sol / ZkTableDecoyUnit.t.sol) jump a table DIRECTLY into an open DEMAND_DECOY dispute window
/// with an arbitrary co-signed `disputeState` and registered deck keys, without driving the full
/// create/join/openDispute(DEMAND_SHOWDOWN)/postShowdownReveals/finalizeShowdown pipeline — that
/// pipeline's REAL transition into DEMAND_DECOY is already covered by
/// ZkTableShowdownUnit.t.sol's `test_finalizeShowdown_badDecode_opensDecoyWindow_noPayout` /
/// `test_finalizeShowdown_duplicateCard_opensDecoyWindow_noPayout`. This harness lets the decoy
/// suites focus purely on `challengeDeck`'s own cryptographic checks (jointKeyCommit / shuffleRoot
/// / deck-chain / verify52 attribution) against deterministic (real-crypto or mocked) transcripts,
/// without needing a full Groth16 showdown-reveal detour just to reach the window.
contract ZkTableDecoyHarness is ZkTable {
    constructor(address factory_, address shuffleVerifier_) ZkTable(factory_, shuffleVerifier_) {}

    /// Wires `tableId` straight into an open DEMAND_DECOY dispute: seats/keys/token bookkeeping,
    /// the two registered deck keys `_challengeDeck` will derive `agg`/`D0` from, and the exact
    /// co-signed `disputeState` a challenge is checked against, with a fresh `clockBlocks`-out
    /// deadline. Mints `token_` balance into this contract directly (bypassing the x402 pull
    /// flow entirely — irrelevant to what this suite tests) so `_payout` has real tokens to move.
    function forceDecoyDispute(
        bytes32 tableId,
        address playerA_,
        address playerB_,
        IX402Token token_,
        uint256[2] calldata deckKeyA,
        uint256[2] calldata deckKeyB,
        uint256 joinStake_,
        uint64 clockBlocks_,
        ChannelState calldata state
    ) external {
        Table storage t = tables[tableId];
        t.playerA = playerA_;
        t.playerB = playerB_;
        t.keyA = playerA_;
        t.keyB = playerB_;
        t.joinStake = joinStake_;
        t.clockBlocks = clockBlocks_;
        t.escrowA = state.balanceA;
        t.escrowB = state.balanceB + state.pot; // arbitrary split; unread by the decoy path itself
        t.status = Status.Disputed;
        t.disputant = 1;
        t.demandKind = DEMAND_DECOY;
        t.disputeState = state;
        t.disputeDeadline = uint64(block.number) + clockBlocks_;
        tableToken[tableId] = token_;
        deckKeys[tableId][1] = deckKeyA;
        deckKeys[tableId][2] = deckKeyB;
    }
}

/// @notice Separate (deliberately tiny) TEST-ONLY harness for ONE synthetic-state assertion:
/// `resolveTimeout`'s EXHAUSTIVE dispatch (H1) reverting `BadDemand` on a demand kind no real
/// writer ever produces. Kept in its OWN contract, not bundled onto `ZkTableDecoyHarness` above,
/// purely to keep each harness's deployed bytecode small — ZkTable's own EIP-170 headroom is
/// tight (see ZkTable.sol's header note on DeckChallengeLib's extraction), and hardhat's default
/// network (unlike Foundry) enforces the 24576-byte deployed-code limit even for test-only
/// contracts.
contract ZkTableBadDemandHarness is ZkTable {
    constructor(address factory_, address shuffleVerifier_) ZkTable(factory_, shuffleVerifier_) {}

    /// Forces an OUT-OF-RANGE `demandKind` directly (bypassing every real writer, which only ever
    /// write 0/DEMAND_MOVE/DEMAND_SHARE/DEMAND_SHOWDOWN/DEMAND_DECOY) — purely so the unit suite
    /// can prove `resolveTimeout`'s dispatch is EXHAUSTIVE (H1): a synthetic unknown kind must hit
    /// the trailing `revert BadDemand()`, not silently fall through some other branch's payout
    /// rule.
    function forceBadDemandKind(bytes32 tableId, uint64 clockBlocks_) external {
        Table storage t = tables[tableId];
        t.status = Status.Disputed;
        t.demandKind = 200; // not 0/1/2/3/4 — unreachable via any real writer
        t.disputeDeadline = uint64(block.number) + clockBlocks_;
    }
}
