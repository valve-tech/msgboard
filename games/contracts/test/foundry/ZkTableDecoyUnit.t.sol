// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ZkTableDecoyHarness, ZkTableBadDemandHarness} from "../../contracts/test/ZkTableDecoyHarness.sol";
import {MockShuffleVerifier52} from "../../contracts/test/MockShuffleVerifier52.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {DeckConstants} from "../../contracts/zk/DeckConstants.sol";
import {EdOnBN254} from "../../contracts/vendor/uzkge/libraries/EdOnBN254.sol";
import {DeckShuffleStep} from "../../contracts/zk/DeckChallengeLib.sol";

/// @notice Fast (no --ffi) coverage for `challengeDeck`'s BOOKKEEPING/dispatch invariants, using
/// `MockShuffleVerifier52` (a scriptable stand-in — see its header) instead of the real Zypher
/// WASM proofs: unattributed-vs-attributed conservation (pure split, no bond — see H-1 in
/// `_adjudicateDecoy`'s header), one-shot settlement, `resolveTimeout`'s exhaustive dispatch,
/// `respondWithState`'s mutual-abort of an open decoy window, and `_clearDispute`'s cross-cycle
/// wipe. The end-to-end REAL-crypto path (genuine verify52 attribution against a genuine Zypher
/// shuffle transcript) is covered separately by `test/ZkTableDecoyChallenge.test.ts` (hardhat —
/// see that file's header for why the real `ShuffleVerifier52`/PlonkVerifier cannot share a
/// Foundry compilation with `ZkTable` at all: mutually exclusive viaIR requirements).
contract ZkTableDecoyUnitTest is Test {
    ZkTableDecoyHarness internal zk;
    ZkTableBadDemandHarness internal badDemandZk;
    MockShuffleVerifier52 internal verifier;
    MockX402 internal token;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    address internal a;
    address internal b;

    uint64 internal constant CLOCK = 30;
    uint256 internal constant JOIN_STAKE = 10 ether;
    uint256 internal constant BAL_A = 10 ether;
    uint256 internal constant BAL_B = 10 ether;
    uint256 internal constant POT = 4 ether + 1; // odd wei

    uint256[2] internal K1 = [uint256(1), uint256(2)];
    uint256[2] internal K2 = [uint256(3), uint256(4)];

    function setUp() public {
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        verifier = new MockShuffleVerifier52();
        zk = new ZkTableDecoyHarness(address(0), address(verifier));
        badDemandZk = new ZkTableBadDemandHarness(address(0), address(verifier));
        token = new MockX402();
        token.mint(address(zk), 1_000 ether);
        token.mint(address(badDemandZk), 1_000 ether);
    }

    // ── fixture builders (self-consistent, no real crypto — verifier is mocked) ──────────────

    function _d0AndAgg() internal view returns (uint256[] memory d0, uint256 aggX, uint256 aggY) {
        (d0, aggX, aggY) = DeckConstants.initialDeckAndAgg(K1, K2);
    }

    function _deck(uint256 seed) internal pure returns (uint256[] memory deck) {
        deck = new uint256[](208);
        for (uint256 i = 0; i < 208; i++) deck[i] = seed + i;
    }

    struct Built {
        DeckShuffleStep[] steps;
        uint256[][] afterDecks;
        bytes[] proofs;
        uint256[24] pkc;
        bytes32 jointKeyCommit;
        bytes32 shuffleRoot;
        bytes32 deckCommitment;
    }

    /// Builds a self-consistent 2-step transcript (seat1 then seat2) rooted at the REAL on-chain
    /// D0 for (K1,K2). `afterDeck1`/`afterDeck2` are arbitrary-but-distinct 208-word arrays (the
    /// mock verifier never inspects their content); pass `seedForFail` a non-zero value with
    /// `failStepIdx` to script `verifier.setFailAt` for that step's call index.
    function _build(uint256 deckSeed) internal view returns (Built memory built) {
        (uint256[] memory d0, uint256 aggX, uint256 aggY) = _d0AndAgg();
        uint256[] memory afterDeck1 = _deck(deckSeed + 1000);
        uint256[] memory afterDeck2 = _deck(deckSeed + 2000);
        bytes memory proof1 = abi.encodePacked("proof1", deckSeed);
        bytes memory proof2 = abi.encodePacked("proof2", deckSeed);

        built.steps = new DeckShuffleStep[](2);
        built.steps[0] = DeckShuffleStep({
            authorSeat: 1,
            beforeHash: keccak256(abi.encodePacked(d0)),
            afterHash: keccak256(abi.encodePacked(afterDeck1)),
            proofHash: keccak256(proof1)
        });
        built.steps[1] = DeckShuffleStep({
            authorSeat: 2,
            beforeHash: keccak256(abi.encodePacked(afterDeck1)),
            afterHash: keccak256(abi.encodePacked(afterDeck2)),
            proofHash: keccak256(proof2)
        });
        built.afterDecks = new uint256[][](2);
        built.afterDecks[0] = afterDeck1;
        built.afterDecks[1] = afterDeck2;
        built.proofs = new bytes[](2);
        built.proofs[0] = proof1;
        built.proofs[1] = proof2;
        for (uint256 i = 0; i < 24; i++) built.pkc[i] = i + 1;
        built.jointKeyCommit = keccak256(abi.encode(aggX, aggY, built.pkc));
        built.shuffleRoot = keccak256(abi.encode(built.steps));
        built.deckCommitment = built.steps[1].afterHash;
    }

    function _state(bytes32 tableId, Built memory built) internal pure returns (ChannelState memory s) {
        s.tableId = tableId;
        s.nonce = 1;
        s.balanceA = BAL_A;
        s.balanceB = BAL_B;
        s.pot = POT;
        s.deckCommitment = built.deckCommitment;
        s.phase = 0;
        s.gameStateHash = bytes32(0);
        s.jointKeyCommit = built.jointKeyCommit;
        s.shuffleRoot = built.shuffleRoot;
    }

    function _open(ZkTableDecoyHarness zkc, bytes32 tableId, Built memory built) internal {
        zkc.forceDecoyDispute(tableId, a, b, IX402Token(address(token)), K1, K2, JOIN_STAKE, CLOCK, _state(tableId, built));
    }

    function _status(ZkTableDecoyHarness zkc, bytes32 id) internal view returns (ChannelTableBase.Status status) {
        (, , , , , , , , , status, , , , , , , , , ) = zkc.tables(id);
    }

    function _demandKind(ZkTableDecoyHarness zkc, bytes32 id) internal view returns (uint8 kind) {
        (, , , , , , , , , , , , , , kind, , , , ) = zkc.tables(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // conservation: unattributable (split) vs attributed (whole-pot forfeit)
    // ═══════════════════════════════════════════════════════════════════════

    /// H-1: every step verifies against the pinned pkc -> UNATTRIBUTABLE (not "frivolous" — see
    /// DeckChallengeLib.verify's header for why this cannot be proven frivolous on-chain), so the
    /// pot SPLITS with no bond charged to the challenger. A bond here would make the honest party
    /// pay for co-sign-time binding fraud the contract cannot pin on a seat.
    function test_challengeDeck_unattributed_conservesEscrow_pureSplit_noBond() public {
        Built memory built = _build(1);
        bytes32 tableId = keccak256("unattributed");
        _open(zk, tableId, built);

        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        vm.prank(a);
        zk.challengeDeck(tableId, built.pkc, built.steps, built.afterDecks, built.proofs);

        uint256 half = POT / 2;
        uint256 expectA = BAL_A + half + (POT - half * 2);
        uint256 expectB = BAL_B + half;
        assertEq(token.balanceOf(a) - beforeA, expectA);
        assertEq(token.balanceOf(b) - beforeB, expectB);
        assertEq((token.balanceOf(a) - beforeA) + (token.balanceOf(b) - beforeB), BAL_A + BAL_B + POT, "conservation");
    }

    function test_challengeDeck_attributed_conservesEscrow_forfeitsWholePot() public {
        Built memory built = _build(2);
        bytes32 tableId = keccak256("attributed");
        _open(zk, tableId, built);
        verifier.setFailAt(1); // step index 1 -> authorSeat 2 -> culprit = seat 2

        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        vm.prank(a);
        zk.challengeDeck(tableId, built.pkc, built.steps, built.afterDecks, built.proofs);

        assertEq(token.balanceOf(a) - beforeA, BAL_A + POT, "honest seat gets balance + WHOLE pot");
        assertEq(token.balanceOf(b) - beforeB, BAL_B, "culprit seat gets only its balance");
        assertEq((token.balanceOf(a) - beforeA) + (token.balanceOf(b) - beforeB), BAL_A + BAL_B + POT, "conservation");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // one-shot: settlement is terminal
    // ═══════════════════════════════════════════════════════════════════════

    function test_challengeDeck_oneShot_secondChallengeRevertsAfterSettle() public {
        Built memory built = _build(4);
        bytes32 tableId = keccak256("one-shot");
        _open(zk, tableId, built);

        vm.prank(a);
        zk.challengeDeck(tableId, built.pkc, built.steps, built.afterDecks, built.proofs);
        assertEq(uint8(_status(zk, tableId)), uint8(ChannelTableBase.Status.Settled));

        // F2's deadline gate (`block.number > t.disputeDeadline`) now fires before
        // DeckChallengeLib.verify's own status check: `_clearDispute` zeroes `disputeDeadline` on
        // settlement, so any post-terminal call trips DecoyWindowExpired first. Either way the
        // one-shot invariant holds — the call reverts and the table stays Settled.
        vm.prank(a);
        vm.expectRevert(ZkTable.DecoyWindowExpired.selector);
        zk.challengeDeck(tableId, built.pkc, built.steps, built.afterDecks, built.proofs);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // resolveTimeout — exhaustive dispatch (H1)
    // ═══════════════════════════════════════════════════════════════════════

    function test_resolveTimeout_revertsBadDemand_onSyntheticUnknownKind() public {
        bytes32 tableId = keccak256("bad-demand");
        badDemandZk.forceBadDemandKind(tableId, CLOCK);
        vm.roll(block.number + CLOCK + 1);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        badDemandZk.resolveTimeout(tableId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // respondWithState MUST NOT abort an open decoy window (F1 fund-critical fix)
    // ═══════════════════════════════════════════════════════════════════════

    /// F1: `respondWithState` used to let a strictly-newer co-signed state mutually abort an open
    /// DEMAND_DECOY window back to Live, erasing the on-chain-proven garbage-decode attribution.
    /// That path is now a hard revert — the window can ONLY resolve via `challengeDeck` (attributed
    /// forfeit) or `resolveTimeout` -> `_resolveDecoyTimeout` (split), both of which pay out, so
    /// blocking this mutual-abort cannot freeze funds.
    function test_respondWithState_revertsWhileDecoyWindowOpen() public {
        Built memory built = _build(5);
        bytes32 tableId = keccak256("no-abort");
        _open(zk, tableId, built);
        assertEq(_demandKind(zk, tableId), 4, "DEMAND_DECOY open");

        ChannelState memory newer = _state(tableId, built);
        newer.nonce = 2; // strictly newer than the pinned disputeState's nonce (1) — would have
        // been accepted pre-fix; must now revert regardless of nonce freshness.
        bytes32 digest = zk.stateDigest(newer);
        (uint8 vA, bytes32 rA, bytes32 sA) = vm.sign(PK_A, digest);
        (uint8 vB, bytes32 rB, bytes32 sB) = vm.sign(PK_B, digest);

        vm.expectRevert(ZkTable.DecoyWindowOpen.selector);
        zk.respondWithState(tableId, newer, abi.encodePacked(rA, sA, vA), abi.encodePacked(rB, sB, vB));

        // The window is still open and untouched — not silently no-op'd into some other state.
        assertEq(uint8(_status(zk, tableId)), uint8(ChannelTableBase.Status.Disputed), "still disputed");
        assertEq(_demandKind(zk, tableId), 4, "decoy demand still open");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // challengeDeck is gated to strictly before the deadline (F2 fund-critical fix)
    // ═══════════════════════════════════════════════════════════════════════

    /// F2: post-deadline, `challengeDeck` (whole-pot attribution) and `resolveTimeout` (split) used
    /// to both be live, letting a cheater front-run an honest late challenge with `resolveTimeout`
    /// to force a split. `challengeDeck` now reverts once `block.number > disputeDeadline`, and
    /// `resolveTimeout` -> `_resolveDecoyTimeout` becomes the ONLY reachable terminal from there.
    function test_challengeDeck_revertsAfterDeadline_thenResolveTimeoutSplits() public {
        Built memory built = _build(6);
        bytes32 tableId = keccak256("late-challenge");
        _open(zk, tableId, built);

        vm.roll(block.number + CLOCK + 1); // strictly past disputeDeadline

        vm.prank(a);
        vm.expectRevert(ZkTable.DecoyWindowExpired.selector);
        zk.challengeDeck(tableId, built.pkc, built.steps, built.afterDecks, built.proofs);

        // resolveTimeout is now the only reachable terminal, and it splits (never a forfeit).
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        zk.resolveTimeout(tableId);

        uint256 half = POT / 2;
        assertEq(token.balanceOf(a) - beforeA, BAL_A + half + (POT - half * 2), "odd wei stays with A");
        assertEq(token.balanceOf(b) - beforeB, BAL_B + half);
        assertEq(uint8(_status(zk, tableId)), uint8(ChannelTableBase.Status.Settled));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // _clearDispute wipes decoy state across cycles (M4)
    // ═══════════════════════════════════════════════════════════════════════

    function test_clearDispute_wipesDecoyStateAcrossCycles() public {
        bytes32 tableId = keccak256("cross-cycle");
        Built memory builtA = _build(10);
        _open(zk, tableId, builtA);

        // Cycle 1: settle via a successful challenge (respondWithState can no longer mutually
        // abort an open decoy window post-F1 — see test_respondWithState_revertsWhileDecoyWindowOpen
        // — so exercise `_clearDispute`'s wipe through challengeDeck's own terminal instead).
        vm.prank(a);
        zk.challengeDeck(tableId, builtA.pkc, builtA.steps, builtA.afterDecks, builtA.proofs);
        assertEq(uint8(_status(zk, tableId)), uint8(ChannelTableBase.Status.Settled));

        // Cycle 2: a FRESH decoy dispute on the SAME table (the harness writes `tables[tableId]`
        // directly, bypassing the real status machine), with a DIFFERENT transcript/commitment.
        Built memory builtB = _build(20);
        _open(zk, tableId, builtB);

        // Submitting cycle A's (now-stale) transcript against cycle B's pinned disputeState must
        // be rejected — proves no cycle-A residue survived _clearDispute's wipe.
        vm.prank(a);
        vm.expectRevert(ZkTable.BadTranscript.selector);
        zk.challengeDeck(tableId, builtA.pkc, builtA.steps, builtA.afterDecks, builtA.proofs);

        // Cycle B's OWN (correct) transcript still works cleanly on the fresh cycle.
        vm.prank(a);
        zk.challengeDeck(tableId, builtB.pkc, builtB.steps, builtB.afterDecks, builtB.proofs);
        assertEq(uint8(_status(zk, tableId)), uint8(ChannelTableBase.Status.Settled));
    }
}
