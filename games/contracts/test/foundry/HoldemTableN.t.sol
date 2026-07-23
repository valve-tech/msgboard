// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelStateN, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";

/// @notice Fuzzes the HoldemTableN lifecycle (create/join/start/settle), the N-seat
/// conservation guard incl. side-pots + rake, per-seat dispute, and the
/// forced-fold-on-timeout — every co-signed state signed for real with vm.sign over the
/// recomputed EIP-712 digest, so the N-of-N recovery path is exercised end to end.
contract HoldemTableNTest is Test {
    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    address internal treasury = address(0x7);

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS

    // a deterministic pool of seat private keys (index => pk)
    function _pk(uint256 i) internal pure returns (uint256) { return 0xA11CE + i * 0x1000 + 1; }

    function setUp() public {
        zk = new HoldemTableN(treasury);
        rules = new MockGameRulesN();
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _emptyState(bytes32 tableId, uint256 n) internal pure returns (ChannelStateN memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.balances = new uint256[](n);
        s.sidePots = new SidePot[](0);
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
    }

    function _coSign(uint256 n, ChannelStateN memory s) internal view returns (bytes[] memory sigs) {
        bytes32 digest = zk.stateDigest(s);
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(_pk(i), digest);
            sigs[i] = abi.encodePacked(r, ss, v);
        }
    }

    /// Create + (n-1) joins + start. Each seat's channel key IS its wallet (vm.addr(pk)).
    function _table(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        address a0 = vm.addr(_pk(0));
        vm.deal(a0, buyIn);
        vm.prank(a0);
        tableId = zk.create{value: buyIn}(IGameRulesN(address(rules)), buyIn, n, 0, 0, CLOCK, a0);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            vm.deal(ai, buyIn);
            vm.prank(ai);
            zk.join{value: buyIn}(tableId, ai);
        }
        vm.prank(a0);
        zk.start(tableId);
    }

    // ── lifecycle / settle ──────────────────────────────────────────────────────

    function _createJoinSettle(uint256 n) internal {
        uint256 buyIn = 3 ether;
        uint256 total = n * buyIn;
        bytes32 tableId = _table(n, buyIn);

        // settle: give everything to seat 0 (a conserving final vector, pot 0)
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = total;
        s.phase = 11; // finalAll => any phase final
        bytes[] memory sigs = _coSign(n, s);

        uint256 before0 = vm.addr(_pk(0)).balance;
        uint256 zkBefore = address(zk).balance;
        vm.prank(vm.addr(_pk(0)));
        zk.settle(tableId, s, sigs);

        assertEq(vm.addr(_pk(0)).balance - before0, total, "seat 0 paid the whole pot");
        assertEq(zkBefore - address(zk).balance, total, "exactly Sigma escrow left the contract");
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Settled), "settled");
        assertEq(address(zk).balance, 0, "no residue");
    }

    function test_createJoinSettle_N2() public { _createJoinSettle(2); }
    function test_createJoinSettle_N3() public { _createJoinSettle(3); }
    function test_createJoinSettle_N5() public { _createJoinSettle(5); }
    function test_createJoinSettle_N9() public { _createJoinSettle(9); }

    /// Fuzz the payout split across all seats for N in {2,3,5,9}; assert every wei paid.
    function testFuzz_settleVectorConserves(uint256 nSeed, uint96 buySeed, uint256 splitSeed) public {
        uint256[4] memory ns = [uint256(2), 3, 5, 9];
        uint256 n = ns[bound(nSeed, 0, 3)];
        uint256 buyIn = bound(uint256(buySeed), 1, 1_000 ether);
        uint256 total = n * buyIn;
        bytes32 tableId = _table(n, buyIn);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.phase = 11;
        // deterministic but varied split summing to total
        uint256 remaining = total;
        for (uint256 i = 0; i < n - 1; i++) {
            uint256 cut = bound(uint256(keccak256(abi.encode(splitSeed, i))), 0, remaining);
            s.balances[i] = cut;
            remaining -= cut;
        }
        s.balances[n - 1] = remaining;
        bytes[] memory sigs = _coSign(n, s);

        uint256[] memory before = new uint256[](n);
        for (uint256 i = 0; i < n; i++) before[i] = vm.addr(_pk(i)).balance;

        vm.prank(vm.addr(_pk(0)));
        zk.settle(tableId, s, sigs);

        for (uint256 i = 0; i < n; i++) {
            assertEq(vm.addr(_pk(i)).balance - before[i], s.balances[i], "seat paid its balance");
        }
        assertEq(address(zk).balance, 0, "no residue");
    }

    // ── conservation guard ──────────────────────────────────────────────────────

    function testFuzz_settleRejectsNonConserving(uint256 nSeed, uint96 buySeed, uint96 skimSeed) public {
        uint256[4] memory ns = [uint256(2), 3, 5, 9];
        uint256 n = ns[bound(nSeed, 0, 3)];
        uint256 buyIn = bound(uint256(buySeed), 1, 1_000 ether);
        uint256 total = n * buyIn;
        bytes32 tableId = _table(n, buyIn);

        uint256 skim = bound(uint256(skimSeed), 1, total);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.phase = 11;
        s.balances[0] = total - skim; // sums to total - skim != total
        bytes[] memory sigs = _coSign(n, s);

        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.ConservationViolated.selector);
        zk.settle(tableId, s, sigs);
        assertEq(address(zk).balance, total, "no funds moved");
    }

    /// Conservation must count side-pots + rake: a state with a side-pot + rake that nets to
    /// the escrow is accepted by openDispute (pot may be nonzero); skewing rake breaks it.
    function test_conservationCountsSidePotsAndRake() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 300
        // need rakeBps>0 for the rake bound; recreate with rakeBps 250, cap big
        address a0 = vm.addr(_pk(0));
        vm.deal(a0, buyIn);
        vm.prank(a0);
        bytes32 tableId = zk.create{value: buyIn}(IGameRulesN(address(rules)), buyIn, n, 250, total, CLOCK, a0);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            vm.deal(ai, buyIn);
            vm.prank(ai);
            zk.join{value: buyIn}(tableId, ai);
        }
        vm.prank(a0);
        zk.start(tableId);

        // 80+80+50 + pot20 + sidePot40 + rake30 = 300 — a conserving CONTESTED state
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = 80; s.balances[1] = 80; s.balances[2] = 50;
        s.pot = 20;
        s.sidePots = new SidePot[](1);
        s.sidePots[0] = SidePot({amount: 40, eligibleMask: 0x5});
        s.rakeAccrued = 30;
        s.phase = 5;
        s.gameStateHash = keccak256("gs");
        bytes[] memory sigs = _coSign(n, s);
        // openDispute accepts it (conservation passes with side-pots + rake counted)
        vm.prank(a0);
        zk.openDispute(tableId, s, sigs, "gs", 2, 1, 0);
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Disputed), "dispute opened");

        // now break conservation: bump rake by 1 -> sums to 301 -> rejected
        s.rakeAccrued = 31;
        bytes[] memory sigs2 = _coSign(n, s);
        vm.prank(a0);
        vm.expectRevert(HoldemTableN.ConservationViolated.selector);
        zk.respondWithState(tableId, s, sigs2); // nonce equal, but conservation checked first
    }

    /// openDispute must enforce the SAME rake ceiling as settle: a conserving disputeState
    /// whose rakeAccrued exceeds rakeCap is rejected (otherwise resolveTimeout could pay out
    /// an over-cap rake). Mirrors settle's `rakeAccrued <= rakeCap` check.
    function test_openDisputeRejectsOverCapRake() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 300
        uint256 rakeCap = 20; // tight cap
        address a0 = vm.addr(_pk(0));
        vm.deal(a0, buyIn);
        vm.prank(a0);
        // openDispute checks only the rakeCap ceiling (the bps reconstruction is settle-only),
        // so the cap is the binding constraint here. rakeBps at the protocol max (250).
        bytes32 tableId = zk.create{value: buyIn}(IGameRulesN(address(rules)), buyIn, n, 250, rakeCap, CLOCK, a0);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            vm.deal(ai, buyIn);
            vm.prank(ai);
            zk.join{value: buyIn}(tableId, ai);
        }
        vm.prank(a0);
        zk.start(tableId);

        // Conserving CONTESTED state, but rakeAccrued = 30 > rakeCap = 20.
        // 80+80+60 + pot20 + rake30 = ... let's make it sum to 300: 70+70+50 + pot80 + rake30 = 300.
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = 70; s.balances[1] = 70; s.balances[2] = 50;
        s.pot = 80;
        s.rakeAccrued = 30; // > rakeCap (20)
        s.phase = 5;
        s.gameStateHash = keccak256("gs");
        bytes[] memory sigs = _coSign(n, s);

        vm.prank(a0);
        vm.expectRevert(HoldemTableN.RakeTooHigh.selector);
        zk.openDispute(tableId, s, sigs, "gs", 2, 1, 0);
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Live), "dispute not opened");

        // Sanity: at/under the cap (rake 20, pot 90) the same shape is accepted.
        s.pot = 90; s.rakeAccrued = 20;
        bytes[] memory sigs2 = _coSign(n, s);
        vm.prank(a0);
        zk.openDispute(tableId, s, sigs2, "gs", 2, 1, 0);
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Disputed), "at-cap dispute opens");
    }

    // ── per-seat dispute + forced fold ──────────────────────────────────────────

    /// A seat that does not respond in its window is force-folded: it keeps its balance,
    /// loses its in-pot stake, the pot goes to the remaining eligible seats, Σ escrow paid.
    function testFuzz_forcedFold(uint256 nSeed, uint96 buySeed, uint256 forfeitSeed, uint96 potSeed) public {
        uint256[3] memory ns = [uint256(2), 3, 5];
        uint256 n = ns[bound(nSeed, 0, 2)];
        uint256 buyIn = bound(uint256(buySeed), 1, 1_000 ether);
        uint256 total = n * buyIn;
        bytes32 tableId = _table(n, buyIn);
        uint8 forfeit = uint8(bound(forfeitSeed, 0, n - 1));

        // contested state: everyone keeps `buyIn/2`, the rest is in the pot
        uint256 keep = buyIn / 2;
        uint256 pot = total - keep * n;
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        for (uint256 i = 0; i < n; i++) s.balances[i] = keep;
        s.pot = pot;
        s.phase = 4;
        s.gameStateHash = keccak256(abi.encode("gs", potSeed));
        bytes[] memory sigs = _coSign(n, s);

        // open a MOVE dispute naming the forfeiting seat (turnMask = max => any seat owes)
        vm.prank(vm.addr(_pk(0) == _pk(forfeit) ? _pk(1) : _pk(0)));
        zk.openDispute(tableId, s, sigs, abi.encode("gs", potSeed), forfeit, 1, 0);

        vm.roll(block.number + CLOCK + 1);

        uint256[] memory before = new uint256[](n);
        for (uint256 i = 0; i < n; i++) before[i] = vm.addr(_pk(i)).balance;

        zk.resolveTimeout(tableId);

        // forfeiting seat got exactly its kept balance (no pot share)
        assertEq(vm.addr(_pk(forfeit)).balance - before[forfeit], keep, "staller keeps balance only");
        // every wei accounted for: sum of deltas == total
        uint256 paid;
        for (uint256 i = 0; i < n; i++) paid += vm.addr(_pk(i)).balance - before[i];
        assertEq(paid, total, "Sigma escrow distributed");
        assertEq(address(zk).balance, 0, "no residue");
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Settled), "settled");
    }

    /// The staller can never GAIN by stalling: its forced-fold payout (balance only) is <=
    /// what it would get if it also shared the pot.
    function test_forcedFoldStallerNeverGains() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = 50; s.balances[1] = 50; s.balances[2] = 50; // 150 in balances
        s.pot = 150; // 150 in pot
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 2, 1, 0); // demand seat 2
        vm.roll(block.number + CLOCK + 1);
        uint256 b2 = vm.addr(_pk(2)).balance;
        zk.resolveTimeout(tableId);
        // seat 2 forfeited: keeps 50, gets none of the 150 pot. seats 0,1 split 150 => +75 each.
        assertEq(vm.addr(_pk(2)).balance - b2, 50, "staller forfeited the pot");
    }

    // ── share dispute wiring (full crypto e2e lives in HoldemShareDispute.t.sol) ─────

    /// respondWithShare on a table that is not in a SHARE dispute reverts on status, never
    /// stranding funds. (The DLEQ-verified happy/forged paths are in HoldemShareDispute.t.sol,
    /// which needs a real off-chain proof via ffi.)
    function test_respondWithShareWrongStatus() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 1 ether);
        uint256[] memory deck = new uint256[](0);
        uint256[2] memory share;
        uint256[5] memory proof;
        vm.expectRevert(HoldemTableN.BadStatus.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    /// registerDeckKey rejects an off-curve point and is locked once the table is Live.
    function test_registerDeckKeyGuards() public {
        uint256 n = 2;
        uint256 buyIn = 1 ether;
        address a0 = vm.addr(_pk(0));
        vm.deal(a0, buyIn);
        vm.prank(a0);
        bytes32 tableId = zk.create{value: buyIn}(IGameRulesN(address(rules)), buyIn, n, 0, 0, CLOCK, a0);
        // off-curve key rejected
        vm.prank(a0);
        vm.expectRevert(HoldemTableN.BadDeckKey.selector);
        zk.registerDeckKey(tableId, [uint256(1), uint256(1)]);
        // valid generator point accepted
        vm.prank(a0);
        zk.registerDeckKey(tableId, [
            0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798,
            0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8
        ]);
        uint256[2] memory got = zk.deckKeyOf(tableId, 0);
        assertEq(got[0], 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798, "key x stored");
        // join a second seat + start, then registration is locked
        address a1 = vm.addr(_pk(1));
        vm.deal(a1, buyIn);
        vm.prank(a1);
        zk.join{value: buyIn}(tableId, a1);
        vm.prank(a0);
        zk.start(tableId);
        vm.prank(a0);
        vm.expectRevert(HoldemTableN.BadStatus.selector);
        zk.registerDeckKey(tableId, [
            0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798,
            0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8
        ]);
    }

    // ── dispute resolved by a newer co-signed state ─────────────────────────────

    function test_respondWithStateClearsDispute() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = 100; s.balances[1] = 100; s.balances[2] = 0;
        s.pot = 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 2, 1, 0);

        // seat 2 answers with a strictly-newer state
        ChannelStateN memory s2 = _emptyState(tableId, n);
        s2.nonce = 2;
        s2.balances[0] = 100; s2.balances[1] = 100; s2.balances[2] = 100;
        s2.phase = 4;
        bytes[] memory sigs2 = _coSign(n, s2);
        vm.prank(vm.addr(_pk(2)));
        zk.respondWithState(tableId, s2, sigs2);
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Live), "back to live");
    }

    /// A stale/forged state is rejected: a state with a non-seat key signature fails.
    function test_settleRejectsForgedSig() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        uint256 total = n * buyIn;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = total;
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        // replace seat 1's sig with a signature from a stranger key
        bytes32 digest = zk.stateDigest(s);
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(0xDEAD, digest);
        sigs[1] = abi.encodePacked(r, ss, v);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.BadSig.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_cannotDemandNonOwingSeat() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        rules.setTurnMask(0x1); // only seat 0 owes
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = 300;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.NotYourTurn.selector);
        zk.openDispute(tableId, s, sigs, "g", 2, 1, 0); // seat 2 does not owe
    }
}
