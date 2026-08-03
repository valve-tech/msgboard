// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CoinFlip} from "../../contracts/CoinFlip.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Deterministic unit coverage for CoinFlip: every external/public function, every custom
/// error CoinFlip declares, the win/loss settle branches (via both the onCast push and the claim
/// pull path), refundStale's timeout/chopped/already-decided branches, and the two-player
/// pairing/matching (queue, FIFO pop, inactive-entry skip, MAX_QUEUE_SCAN cap) logic. Modeled on
/// CoinFlipTablesUnit.t.sol's approach: hand-picked inputs (no fuzzing) so a branch-coverage pass
/// attributes each hit deterministically. CoinFlip.t.sol already fuzzes the parity-winner-takes-pot
/// and settled-cannot-be-refunded properties; this suite fills in everything else.
contract CoinFlipUnitTest is Test {
    CoinFlip internal coin;
    MockRandom internal rnd;

    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    uint8 internal constant HEADS = 0;
    uint8 internal constant TAILS = 1;
    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant MAX_QUEUE_SCAN = 32;

    bytes32 internal constant ENTERED_SIG =
        keccak256("Entered(uint256,address,uint8,uint256,bytes32)");
    bytes32 internal constant PAIRED_SIG =
        keccak256("Paired(bytes32,address,address,uint256)");
    bytes32 internal constant HEATED_SIG = keccak256("Heated(bytes32,bytes32)");

    // seeds chosen for LSB parity: EVEN seed's parity bit is 0 (HEADS wins), ODD's is 1 (TAILS wins).
    bytes32 internal constant SEED_EVEN = bytes32(uint256(2));
    bytes32 internal constant SEED_ODD = bytes32(uint256(1));

    function setUp() public {
        rnd = new MockRandom();
        coin = new CoinFlip(address(rnd));
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            coin.addValidator(v);
            subset.push(v);
            locs.push(PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            }));
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _enter(address player, uint8 side) internal returns (uint256 id) {
        vm.deal(player, STAKE);
        vm.prank(player);
        id = coin.enterAndMatch{value: STAKE}(side, subset, locs);
    }

    /// @dev `first` enters `firstSide` (queues), then `second` enters the opposite side (pairs +
    /// heats). Returns the flipId/key parsed off the Paired/Heated events, mirroring
    /// CoinFlipFuzzTest._pair.
    function _pair(address first, uint8 firstSide, address second)
        internal
        returns (bytes32 flipId, bytes32 key)
    {
        uint8 secondSide = firstSide == HEADS ? TAILS : HEADS;
        _enter(first, firstSide);

        vm.recordLogs();
        vm.deal(second, STAKE);
        vm.prank(second);
        coin.enterAndMatch{value: STAKE}(secondSide, subset, locs);
        Vm.Log[] memory logsList = vm.getRecordedLogs();
        for (uint256 i = 0; i < logsList.length; i++) {
            if (logsList[i].topics[0] == PAIRED_SIG) flipId = logsList[i].topics[1];
            if (logsList[i].topics[0] == HEATED_SIG) key = logsList[i].topics[2];
        }
        require(flipId != bytes32(0) && key != bytes32(0), "pairing failed");
    }

    function _pairHeadsFirst(address heads, address tails) internal returns (bytes32 flipId, bytes32 key) {
        return _pair(heads, HEADS, tails);
    }

    function _entryActive(uint256 id) internal view returns (bool active) {
        (, , , , , active) = coin.entries(id);
    }

    function _flipStatus(bytes32 flipId) internal view returns (CoinFlip.Status status) {
        (, , , , , status) = coin.flips(flipId);
    }

    // ── enterAndMatch: input validation ────────────────────────────────────

    function test_enterAndMatch_wrongSide() public {
        address p = address(0xA1);
        vm.deal(p, STAKE);
        vm.prank(p);
        vm.expectRevert(CoinFlip.WrongSide.selector);
        coin.enterAndMatch{value: STAKE}(2, subset, locs);
    }

    function test_enterAndMatch_zeroStake() public {
        address p = address(0xA2);
        vm.prank(p);
        vm.expectRevert(CoinFlip.ZeroStake.selector);
        coin.enterAndMatch{value: 0}(HEADS, subset, locs);
    }

    // ── enterAndMatch: queue vs immediate pairing ──────────────────────────

    function test_enterAndMatch_queuesAlone() public {
        address p = address(0xB1);
        bytes32 subsetHash = keccak256(abi.encode(subset));

        vm.expectEmit(true, true, false, true, address(coin));
        emit CoinFlip.Entered(1, p, HEADS, STAKE, subsetHash);
        uint256 id = _enter(p, HEADS);

        assertEq(id, 1, "first entrant gets id 1");
        (address ePlayer, uint8 eSide, uint256 eStake, bytes32 eSubsetHash, uint256 eBlock, bool eActive) =
            coin.entries(id);
        assertEq(ePlayer, p, "player recorded");
        assertEq(eSide, HEADS, "side recorded");
        assertEq(eStake, STAKE, "stake recorded");
        assertEq(eSubsetHash, subsetHash, "subset hash recorded");
        assertEq(eBlock, block.number, "block recorded");
        assertTrue(eActive, "entry left active, waiting in queue");
        assertEq(address(coin).balance, STAKE, "stake escrowed, no pairing occurred");
    }

    function test_enterAndMatch_pairsHeadsFirst() public {
        address heads = address(0xC1);
        address tails = address(0xC2);

        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);

        (address fHeads, address fTails, uint256 fStake, bytes32 fKey, uint256 fPairedAt, CoinFlip.Status fStatus) =
            coin.flips(flipId);
        assertEq(fHeads, heads, "heads assigned correctly (a.side==HEADS branch)");
        assertEq(fTails, tails, "tails assigned correctly");
        assertEq(fStake, STAKE);
        assertEq(fKey, key);
        assertEq(fPairedAt, block.number);
        assertTrue(fStatus == CoinFlip.Status.Pending);
        assertFalse(_entryActive(1), "matched entry (queued side) deactivated");
        assertFalse(_entryActive(2), "matched entry (incoming side) deactivated");
        assertEq(address(coin).balance, STAKE * 2, "both stakes escrowed");
    }

    /// @notice Covers the OTHER branch of `_pairAndHeat`'s `a.side == HEADS ? (a,b) : (b,a)` ternary:
    /// the QUEUED entrant (a) is TAILS, so heads/tails must be swapped from the enterAndMatch order.
    function test_enterAndMatch_pairsTailsFirst() public {
        address tails = address(0xC3);
        address heads = address(0xC4);

        (bytes32 flipId, ) = _pair(tails, TAILS, heads);

        (address fHeads, address fTails, , , , ) = coin.flips(flipId);
        assertEq(fHeads, heads, "second entrant (HEADS) correctly placed as heads");
        assertEq(fTails, tails, "first/queued entrant (TAILS) correctly placed as tails");
    }

    /// @notice `_popQueued` must skip an inactive (cancelled) queue entry and keep scanning to find
    /// the next active one — exercising both the true and false outcomes of `entries[candidate].active`
    /// within a single FIFO queue.
    function test_popQueued_skipsInactiveEntry() public {
        address p1 = address(0xD1); // queues then cancels -> inactive tombstone, still in queue array
        address p2 = address(0xD2); // queues behind p1, stays active
        address p3 = address(0xD3); // opposite side, should match p2 (skipping p1)

        uint256 id1 = _enter(p1, HEADS);
        vm.prank(p1);
        coin.cancel(id1);
        assertFalse(_entryActive(id1));

        uint256 id2 = _enter(p2, HEADS);

        vm.recordLogs();
        vm.deal(p3, STAKE);
        vm.prank(p3);
        coin.enterAndMatch{value: STAKE}(TAILS, subset, locs);
        Vm.Log[] memory logsList = vm.getRecordedLogs();
        bytes32 flipId;
        for (uint256 i = 0; i < logsList.length; i++) {
            if (logsList[i].topics[0] == PAIRED_SIG) flipId = logsList[i].topics[1];
        }
        require(flipId != bytes32(0), "expected a pairing");

        (address fHeads, address fTails, , , , ) = coin.flips(flipId);
        assertEq(fHeads, p2, "matched the active p2, not cancelled p1");
        assertEq(fTails, p3);
        assertFalse(_entryActive(id2), "p2's entry consumed by the match");
        // p1's stake was refunded on cancel; p2+p3 are now escrowed in the paired flip.
        assertEq(address(coin).balance, STAKE * 2, "only the paired stakes remain escrowed");
    }

    /// @notice `_popQueued` caps its scan at MAX_QUEUE_SCAN: with MORE inactive entries queued than
    /// the cap, a new opposite-side entrant must fail to match (and queue instead), proving the loop
    /// exits via `scanned < MAX_QUEUE_SCAN` going false rather than `head < q.length` going false.
    function test_popQueued_scanCapExhausted() public {
        uint256 n = MAX_QUEUE_SCAN + 8; // strictly more than the cap
        for (uint256 i = 0; i < n; i++) {
            address p = address(uint160(0x9000 + i));
            uint256 id = _enter(p, HEADS);
            vm.prank(p);
            coin.cancel(id);
        }
        assertEq(address(coin).balance, 0, "all queued-and-cancelled stakes refunded");

        address late = address(0xE1);
        vm.recordLogs();
        vm.deal(late, STAKE);
        vm.prank(late);
        uint256 lateId = coin.enterAndMatch{value: STAKE}(TAILS, subset, locs);
        Vm.Log[] memory logsList = vm.getRecordedLogs();
        for (uint256 i = 0; i < logsList.length; i++) {
            assertTrue(logsList[i].topics[0] != PAIRED_SIG, "cap exhaustion must not find a match");
        }
        assertTrue(_entryActive(lateId), "unmatched entrant queues instead of pairing");
        assertEq(address(coin).balance, STAKE, "only the new entrant's stake is escrowed");
    }

    // ── cancel ──────────────────────────────────────────────────────────────

    function test_cancel_happy() public {
        address p = address(0xF1);
        uint256 id = _enter(p, HEADS);
        uint256 balBefore = p.balance;

        vm.expectEmit(true, false, false, false, address(coin));
        emit CoinFlip.Cancelled(id);
        vm.prank(p);
        coin.cancel(id);

        assertFalse(_entryActive(id), "entry becomes an inactive tombstone");
        assertEq(p.balance, balBefore + STAKE, "stake refunded");
        assertEq(address(coin).balance, 0, "no dust left");
    }

    function test_cancel_notEntrant() public {
        address p = address(0xF2);
        address stranger = address(0xF3);
        uint256 id = _enter(p, HEADS);

        vm.prank(stranger);
        vm.expectRevert(CoinFlip.NotEntrant.selector);
        coin.cancel(id);
    }

    function test_cancel_alreadyResolved() public {
        address p = address(0xF4);
        uint256 id = _enter(p, HEADS);
        vm.prank(p);
        coin.cancel(id);

        vm.prank(p);
        vm.expectRevert(CoinFlip.AlreadyResolved.selector);
        coin.cancel(id);
    }

    // ── _settle via onCast (push): win/loss branches + AlreadyResolved guard ──

    function test_onCast_headsWins() public {
        address heads = address(0x1A1);
        address tails = address(0x1A2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        uint256 headsBefore = heads.balance;
        uint256 tailsBefore = tails.balance;

        vm.expectEmit(true, true, false, true, address(coin));
        emit CoinFlip.Settled(flipId, heads, HEADS, STAKE * 2, SEED_EVEN);
        rnd.pushCast(address(coin), key, SEED_EVEN);

        assertEq(heads.balance, headsBefore + STAKE * 2, "heads (parity winner) takes the pot");
        assertEq(tails.balance, tailsBefore, "tails gets nothing");
        assertTrue(_flipStatus(flipId) == CoinFlip.Status.Settled);
        assertEq(address(coin).balance, 0, "no dust");
    }

    function test_onCast_tailsWins() public {
        address heads = address(0x1B1);
        address tails = address(0x1B2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        uint256 headsBefore = heads.balance;
        uint256 tailsBefore = tails.balance;

        vm.expectEmit(true, true, false, true, address(coin));
        emit CoinFlip.Settled(flipId, tails, TAILS, STAKE * 2, SEED_ODD);
        rnd.pushCast(address(coin), key, SEED_ODD);

        assertEq(tails.balance, tailsBefore + STAKE * 2, "tails (parity winner) takes the pot");
        assertEq(heads.balance, headsBefore, "heads gets nothing");
        assertTrue(_flipStatus(flipId) == CoinFlip.Status.Settled);
    }

    function test_onCast_doubleCast_alreadyResolved() public {
        address heads = address(0x1C1);
        address tails = address(0x1C2);
        (, bytes32 key) = _pairHeadsFirst(heads, tails);

        rnd.pushCast(address(coin), key, SEED_EVEN); // settles fine

        vm.expectRevert(CoinFlip.AlreadyResolved.selector);
        rnd.pushCast(address(coin), key, SEED_ODD); // second delivery for the same key
    }

    // ── claim (pull fallback): both win outcomes + guards ──────────────────

    function test_claim_headsWins() public {
        address heads = address(0x2A1);
        address tails = address(0x2A2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        uint256 headsBefore = heads.balance;

        rnd.setSeed(key, SEED_EVEN); // finalize WITHOUT delivering the push
        coin.claim(flipId);

        assertEq(heads.balance, headsBefore + STAKE * 2, "claim pays the parity winner (heads)");
        assertTrue(_flipStatus(flipId) == CoinFlip.Status.Settled);
    }

    function test_claim_tailsWins() public {
        address heads = address(0x2B1);
        address tails = address(0x2B2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        uint256 tailsBefore = tails.balance;

        rnd.setSeed(key, SEED_ODD);
        coin.claim(flipId);

        assertEq(tails.balance, tailsBefore + STAKE * 2, "claim pays the parity winner (tails)");
        assertTrue(_flipStatus(flipId) == CoinFlip.Status.Settled);
    }

    function test_claim_tooEarly() public {
        address heads = address(0x2C1);
        address tails = address(0x2C2);
        (bytes32 flipId, ) = _pairHeadsFirst(heads, tails);

        vm.expectRevert(CoinFlip.TooEarly.selector);
        coin.claim(flipId);
    }

    function test_claim_alreadyResolved() public {
        address heads = address(0x2D1);
        address tails = address(0x2D2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        rnd.pushCast(address(coin), key, SEED_EVEN);

        vm.expectRevert(CoinFlip.AlreadyResolved.selector);
        coin.claim(flipId);
    }

    // ── refundStale ─────────────────────────────────────────────────────────

    /// @notice Regression: a flip whose seed HAS finalized (value-decided) can never be unwound to a
    /// mutual refund, even before any timeout — the first TooEarly guard fires unconditionally.
    function test_refundStale_tooEarly_seedFinalized() public {
        address heads = address(0x3A1);
        address tails = address(0x3A2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);

        rnd.setSeed(key, SEED_EVEN); // finalized but not yet delivered/claimed
        vm.expectRevert(CoinFlip.TooEarly.selector);
        coin.refundStale(flipId);
    }

    /// @notice Seed missing, not chopped, not stale yet -> the second TooEarly guard fires.
    function test_refundStale_tooEarly_immediate() public {
        address heads = address(0x3B1);
        address tails = address(0x3B2);
        (bytes32 flipId, ) = _pairHeadsFirst(heads, tails);

        vm.expectRevert(CoinFlip.TooEarly.selector);
        coin.refundStale(flipId);
    }

    function test_refundStale_timeout_happy() public {
        address heads = address(0x3C1);
        address tails = address(0x3C2);
        (bytes32 flipId, ) = _pairHeadsFirst(heads, tails);
        uint256 headsBefore = heads.balance;
        uint256 tailsBefore = tails.balance;

        vm.roll(block.number + coin.STALE_BLOCKS() + 1);
        coin.refundStale(flipId);

        assertEq(heads.balance, headsBefore + STAKE, "heads reclaims own stake");
        assertEq(tails.balance, tailsBefore + STAKE, "tails reclaims own stake");
        assertTrue(_flipStatus(flipId) == CoinFlip.Status.Refunded);
        assertEq(address(coin).balance, 0, "no dust");
    }

    function test_refundStale_chopped_happy() public {
        address heads = address(0x3D1);
        address tails = address(0x3D2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        uint256 headsBefore = heads.balance;
        uint256 tailsBefore = tails.balance;

        rnd.pushChop(address(coin), key); // marks choppedInstance[flipId] = true

        // BEFORE the STALE_BLOCKS window elapses — only reachable via the chopped branch.
        coin.refundStale(flipId);

        assertEq(heads.balance, headsBefore + STAKE);
        assertEq(tails.balance, tailsBefore + STAKE);
        assertTrue(_flipStatus(flipId) == CoinFlip.Status.Refunded);
    }

    function test_refundStale_alreadyResolvedAfterSettle() public {
        address heads = address(0x3E1);
        address tails = address(0x3E2);
        (bytes32 flipId, bytes32 key) = _pairHeadsFirst(heads, tails);
        rnd.pushCast(address(coin), key, SEED_EVEN);

        vm.expectRevert(CoinFlip.AlreadyResolved.selector);
        coin.refundStale(flipId);
    }

    function test_refundStale_doubleRefundAlreadyResolved() public {
        address heads = address(0x3F1);
        address tails = address(0x3F2);
        (bytes32 flipId, ) = _pairHeadsFirst(heads, tails);
        vm.roll(block.number + coin.STALE_BLOCKS() + 1);
        coin.refundStale(flipId);

        vm.expectRevert(CoinFlip.AlreadyResolved.selector);
        coin.refundStale(flipId);
    }
}
