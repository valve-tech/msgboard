// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";

/// @notice Fuzzes the ZkTable lifecycle (create/join/top-up/settle), the conservation
/// guard, dispute timeouts, and the clock bounds. Every co-signed state is signed for
/// real with `vm.sign` over the recomputed EIP-712 digest (solady domain
/// ("ZkTable","1", chainid, address(zk))), so the signature recovery path is exercised
/// end to end — not stubbed.
contract ZkTableFuzzTest is Test {
    ZkTable internal zk;
    MockGameRules internal rules;

    uint256 internal pkA = 0xA11CE;
    uint256 internal pkB = 0xB0B;
    address internal a;
    address internal b;

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];

    function setUp() public {
        zk = new ZkTable();
        rules = new MockGameRules();
        a = vm.addr(pkA);
        b = vm.addr(pkB);
        vm.deal(a, 1_000_000 ether);
        vm.deal(b, 1_000_000 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _emptyState(bytes32 tableId) internal pure returns (ChannelState memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
    }

    function _coSign(ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 ss1) = vm.sign(pkA, digest);
        (uint8 v2, bytes32 r2, bytes32 ss2) = vm.sign(pkB, digest);
        sigA = abi.encodePacked(r1, ss1, v1);
        sigB = abi.encodePacked(r2, ss2, v2);
    }

    function _seatState(bytes32 tableId) internal view returns (uint256 escA, uint256 escB, ZkTable.Status status) {
        (, , , , escA, escB, , , , status, , , , , , , ) = zk.tables(tableId);
    }

    /// Create (A) + join (B), returning the table id and the total escrow on the table.
    function _createJoin(uint256 escrowA, uint256 stake) internal returns (bytes32 tableId) {
        vm.prank(a);
        tableId = zk.create{value: escrowA}(IGameRules(address(rules)), stake, CLOCK, a, ZERO_DECK);
        vm.prank(b);
        zk.join{value: stake}(tableId, b, ZERO_DECK);
    }

    // ── fuzz cases ───────────────────────────────────────────────────────────

    /// Full happy path: create, join, top-up both seats, then settle a conserving
    /// final state. The split is fuzzed against the known total escrow; every wei is
    /// paid out and the contract is left with zero residue for this table's funds.
    function testFuzz_createJoinSettle(uint96 escrowA, uint96 stake, uint96 topA, uint96 topB, uint96 split) public {
        uint256 eA = bound(uint256(escrowA), 1, 100_000 ether);
        uint256 st = bound(uint256(stake), 1, 100_000 ether);
        uint256 tA = bound(uint256(topA), 0, 100_000 ether);
        uint256 tB = bound(uint256(topB), 0, 100_000 ether);

        bytes32 tableId = _createJoin(eA, st);
        if (tA > 0) {
            vm.prank(a);
            zk.topUp{value: tA}(tableId);
        }
        if (tB > 0) {
            vm.prank(b);
            zk.topUp{value: tB}(tableId);
        }

        uint256 total = eA + st + tA + tB;
        uint256 toA = bound(uint256(split), 0, total);
        uint256 toB = total - toA;

        ChannelState memory s = _emptyState(tableId);
        s.nonce = 1;
        s.balanceA = toA;
        s.balanceB = toB;
        s.pot = 0;
        s.phase = 1; // finalAll = true, so any phase is final
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        uint256 zkBefore = address(zk).balance;

        vm.prank(a);
        zk.settle(tableId, s, sigA, sigB);

        assertEq(a.balance - beforeA, toA, "A paid its balance");
        assertEq(b.balance - beforeB, toB, "B paid its balance");
        assertEq(zkBefore - address(zk).balance, total, "exactly the table escrow left the contract");

        (uint256 escA, uint256 escB, ZkTable.Status status) = _seatState(tableId);
        assertEq(uint8(status), uint8(ZkTable.Status.Settled), "terminal");
        assertEq(escA, 0, "escrowA zeroed");
        assertEq(escB, 0, "escrowB zeroed");
    }

    /// A state that skims wei (balanceA + balanceB + pot != escrow) must be rejected by
    /// the conservation guard, regardless of how the skim is distributed.
    function testFuzz_settleRejectsNonConserving(uint96 escrowA, uint96 stake, uint96 skim) public {
        uint256 eA = bound(uint256(escrowA), 1, 100_000 ether);
        uint256 st = bound(uint256(stake), 1, 100_000 ether);
        uint256 total = eA + st;
        uint256 sk = bound(uint256(skim), 1, total); // strictly positive mismatch

        bytes32 tableId = _createJoin(eA, st);

        ChannelState memory s = _emptyState(tableId);
        s.nonce = 1;
        s.balanceA = total - sk; // sums to total - sk != total
        s.balanceB = 0;
        s.pot = 0;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        vm.prank(a);
        vm.expectRevert(ZkTable.ConservationViolated.selector);
        zk.settle(tableId, s, sigA, sigB);

        assertEq(address(zk).balance, total, "no funds moved");
    }

    /// Open a MOVE dispute, let the clock expire unanswered, and resolve: the disputant
    /// (seat A here) is awarded balance + pot, the counterparty its balance. Fuzzed over
    /// the balance/pot split of the contested conserving state.
    function testFuzz_timeoutPaysDisputantPot(uint96 escrowA, uint96 stake, uint96 potSeed, uint96 balSeed) public {
        uint256 eA = bound(uint256(escrowA), 1, 100_000 ether);
        uint256 st = bound(uint256(stake), 1, 100_000 ether);
        uint256 total = eA + st;

        uint256 pot = bound(uint256(potSeed), 0, total);
        uint256 rem = total - pot;
        uint256 balA = bound(uint256(balSeed), 0, rem);
        uint256 balB = rem - balA;

        bytes32 tableId = _createJoin(eA, st);

        bytes memory gameState = abi.encode("gs", potSeed);
        ChannelState memory s = _emptyState(tableId);
        s.nonce = 1;
        s.balanceA = balA;
        s.balanceB = balB;
        s.pot = pot;
        s.phase = 0;
        s.gameStateHash = keccak256(gameState); // mock hashGameState == keccak256
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        // A opens a MOVE dispute demanding from B (turnMask=3 => both owe, so it passes).
        vm.prank(a);
        zk.openDispute(tableId, s, sigA, sigB, gameState, 1, 0);

        vm.roll(block.number + CLOCK + 1); // past the deadline

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.resolveTimeout(tableId);

        assertEq(a.balance - beforeA, balA + pot, "disputant A gets balance + pot");
        assertEq(b.balance - beforeB, balB, "counterparty B gets its balance");
        assertEq(address(zk).balance, 0, "no dust");

        (uint256 escA, uint256 escB, ZkTable.Status status) = _seatState(tableId);
        assertEq(uint8(status), uint8(ZkTable.Status.Settled), "terminal");
        assertEq(escA, 0, "escrowA zeroed");
        assertEq(escB, 0, "escrowB zeroed");
    }

    /// create reverts BadClock for any clockBlocks outside [MIN, MAX]; succeeds inside.
    function testFuzz_clockBounds(uint64 blocks) public {
        uint64 minC = zk.MIN_CLOCK_BLOCKS();
        uint64 maxC = zk.MAX_CLOCK_BLOCKS();
        vm.deal(a, 10 ether);
        if (blocks < minC || blocks > maxC) {
            vm.prank(a);
            vm.expectRevert(ZkTable.BadClock.selector);
            zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, blocks, a, ZERO_DECK);
        } else {
            vm.prank(a);
            bytes32 tableId = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, blocks, a, ZERO_DECK);
            (uint256 escA, , ZkTable.Status status) = _seatState(tableId);
            assertEq(escA, 1 ether, "escrow recorded");
            assertEq(uint8(status), uint8(ZkTable.Status.Created), "created");
        }
    }
}
