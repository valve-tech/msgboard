// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelStateN, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// @notice Fuzzes the HoldemTableN lifecycle (create/join/start/settle), the N-seat
/// conservation guard incl. side-pots + rake, per-seat dispute, and the
/// forced-fold-on-timeout — every co-signed state signed for real with vm.sign over the
/// recomputed EIP-712 digest, so the N-of-N recovery path is exercised end to end.
contract HoldemTableNTest is Test {
    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    MockX402 internal token;
    address internal treasury = address(0x7);

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS

    // a deterministic pool of seat private keys (index => pk)
    function _pk(uint256 i) internal pure returns (uint256) { return 0xA11CE + i * 0x1000 + 1; }

    // secp256k1 generator — a convenient on-curve deck key. create()/join() now require one
    // directly for every seat; these suites don't verify real shares.
    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

    function setUp() public {
        zk = new HoldemTableN(treasury, address(0));
        rules = new MockGameRulesN();
        token = new MockX402();
        for (uint256 i = 0; i <= 9; i++) {
            token.mint(vm.addr(_pk(i)), 10_000_000 ether);
        }
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

    // ── x402 deposit-auth helpers ────────────────────────────────────────────

    uint64 internal constant VALID_BEFORE = type(uint64).max;

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return HoldemTableN.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _createAuth(
        uint256 pk,
        address from,
        uint256 buyIn,
        IGameRulesN rules_,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clock,
        address channelKey,
        uint256[2] memory deckKey
    ) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, bytes32(0));
        return _authFor(pk, from, buyIn, nonce);
    }

    function _joinAuth(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey)
        internal
        returns (HoldemTableN.DepositAuth memory)
    {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey, bytes32(0));
        return _authFor(pk, from, stake, nonce);
    }

    /// create() with a signed auth for seat pk, relayed by that same seat (vm.prank(from)).
    function _create(
        uint256 pk,
        IGameRulesN rules_,
        uint256 buyIn,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clock,
        address channelKey,
        uint256[2] memory deckKey
    ) internal returns (bytes32 tableId) {
        address from = vm.addr(pk);
        HoldemTableN.DepositAuth memory auth = _createAuth(pk, from, buyIn, rules_, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, auth);
    }

    /// join() with a signed auth for seat pk, relayed by that same seat (vm.prank(from)).
    function _join(uint256 pk, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        address from = vm.addr(pk);
        HoldemTableN.DepositAuth memory auth = _joinAuth(pk, from, tableId, stake, channelKey, deckKey);
        vm.prank(from);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    /// Create + (n-1) joins + start. Each seat's channel key IS its wallet (vm.addr(pk)); every
    /// seat's deck key is the generator, set directly at create()/join() time.
    function _table(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        address a0 = vm.addr(_pk(0));
        tableId = _create(_pk(0), IGameRulesN(address(rules)), buyIn, n, 0, 0, CLOCK, a0, [GX, GY]);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            _join(_pk(i), tableId, buyIn, ai, [GX, GY]);
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

        uint256 before0 = token.balanceOf(vm.addr(_pk(0)));
        uint256 zkBefore = token.balanceOf(address(zk));
        vm.prank(vm.addr(_pk(0)));
        zk.settle(tableId, s, sigs);

        assertEq(token.balanceOf(vm.addr(_pk(0))) - before0, total, "seat 0 paid the whole pot");
        assertEq(zkBefore - token.balanceOf(address(zk)), total, "exactly Sigma escrow left the contract");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Settled), "settled");
        assertEq(token.balanceOf(address(zk)), 0, "no residue");
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
        for (uint256 i = 0; i < n; i++) before[i] = token.balanceOf(vm.addr(_pk(i)));

        vm.prank(vm.addr(_pk(0)));
        zk.settle(tableId, s, sigs);

        for (uint256 i = 0; i < n; i++) {
            assertEq(token.balanceOf(vm.addr(_pk(i))) - before[i], s.balances[i], "seat paid its balance");
        }
        assertEq(token.balanceOf(address(zk)), 0, "no residue");
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
        vm.expectRevert(ChannelTableBase.ConservationViolated.selector);
        zk.settle(tableId, s, sigs);
        assertEq(token.balanceOf(address(zk)), total, "no funds moved");
    }

    /// Conservation must count side-pots + rake: a state with a side-pot + rake that nets to
    /// the escrow is accepted by openDispute (pot may be nonzero); skewing rake breaks it.
    function test_conservationCountsSidePotsAndRake() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 300
        // need rakeBps>0 for the rake bound; recreate with rakeBps 250, cap big
        address a0 = vm.addr(_pk(0));
        bytes32 tableId = _create(_pk(0), IGameRulesN(address(rules)), buyIn, n, 250, total, CLOCK, a0, [GX, GY]);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            _join(_pk(i), tableId, buyIn, ai, [GX, GY]);
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
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Disputed), "dispute opened");

        // now break conservation: bump rake by 1 -> sums to 301 -> rejected
        s.rakeAccrued = 31;
        bytes[] memory sigs2 = _coSign(n, s);
        vm.prank(a0);
        vm.expectRevert(ChannelTableBase.ConservationViolated.selector);
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
        // openDispute checks only the rakeCap ceiling (the bps reconstruction is settle-only),
        // so the cap is the binding constraint here. rakeBps at the protocol max (250).
        bytes32 tableId = _create(_pk(0), IGameRulesN(address(rules)), buyIn, n, 250, rakeCap, CLOCK, a0, [GX, GY]);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            _join(_pk(i), tableId, buyIn, ai, [GX, GY]);
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
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "dispute not opened");

        // Sanity: at/under the cap (rake 20, pot 90) the same shape is accepted.
        s.pot = 90; s.rakeAccrued = 20;
        bytes[] memory sigs2 = _coSign(n, s);
        vm.prank(a0);
        zk.openDispute(tableId, s, sigs2, "gs", 2, 1, 0);
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Disputed), "at-cap dispute opens");
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
        for (uint256 i = 0; i < n; i++) before[i] = token.balanceOf(vm.addr(_pk(i)));

        zk.resolveTimeout(tableId);

        // forfeiting seat got exactly its kept balance (no pot share)
        assertEq(token.balanceOf(vm.addr(_pk(forfeit))) - before[forfeit], keep, "staller keeps balance only");
        // every wei accounted for: sum of deltas == total
        uint256 paid;
        for (uint256 i = 0; i < n; i++) paid += token.balanceOf(vm.addr(_pk(i))) - before[i];
        assertEq(paid, total, "Sigma escrow distributed");
        assertEq(token.balanceOf(address(zk)), 0, "no residue");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Settled), "settled");
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
        uint256 b2 = token.balanceOf(vm.addr(_pk(2)));
        zk.resolveTimeout(tableId);
        // seat 2 forfeited: keeps 50, gets none of the 150 pot. seats 0,1 split 150 => +75 each.
        assertEq(token.balanceOf(vm.addr(_pk(2))) - b2, 50, "staller forfeited the pot");
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
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    /// registerDeckKey now ROTATES the key create()/join() already set: rejects an off-curve
    /// point, accepts a new on-curve point that overwrites the initial one, and is locked once
    /// the table is Live.
    function test_registerDeckKeyGuards() public {
        uint256 n = 2;
        uint256 buyIn = 1 ether;
        address a0 = vm.addr(_pk(0));
        // create() already sets seat 0's initial deck key to the generator.
        bytes32 tableId = _create(_pk(0), IGameRulesN(address(rules)), buyIn, n, 0, 0, CLOCK, a0, [GX, GY]);
        assertEq(zk.deckKeyOf(tableId, 0)[0], GX, "initial key set directly by create()");
        // off-curve key rejected (rotation attempt)
        vm.prank(a0);
        vm.expectRevert(HoldemTableN.BadDeckKey.selector);
        zk.registerDeckKey(tableId, [uint256(1), uint256(1)]);
        // a DIFFERENT on-curve point (2G) rotates/overwrites the initial one
        uint256 g2x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5;
        uint256 g2y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a;
        vm.prank(a0);
        zk.registerDeckKey(tableId, [g2x, g2y]);
        uint256[2] memory got = zk.deckKeyOf(tableId, 0);
        assertEq(got[0], g2x, "rotated key overwrote the initial one");
        // join a second seat (its own initial key from join()) + start, then rotation is locked
        address a1 = vm.addr(_pk(1));
        _join(_pk(1), tableId, buyIn, a1, [GX, GY]);
        vm.prank(a0);
        zk.start(tableId);
        vm.prank(a0);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.registerDeckKey(tableId, [GX, GY]);
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
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "back to live");
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
        vm.expectRevert(ChannelTableBase.BadSig.selector);
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
        vm.expectRevert(ChannelTableBase.NotYourTurn.selector);
        zk.openDispute(tableId, s, sigs, "g", 2, 1, 0); // seat 2 does not owe
    }
}
