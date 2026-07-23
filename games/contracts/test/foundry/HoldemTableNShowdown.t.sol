// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelStateN, SidePot as ChannelSidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {HoldemRules} from "../../contracts/zk/HoldemRules.sol";

/// @notice Task 7 channel-settle acceptance: drive the real HoldemRules SHOWDOWN resolution,
/// bridge the resulting per-seat balances + rake into a ChannelStateN, co-sign N-of-N and
/// submit to HoldemTableN.settle — proving the showdown-derived state the channel verifies is
/// accepted on-chain and pays out exactly Σ escrow (Σ payouts + rake), residue 0.
contract HoldemTableNShowdownTest is Test {
    HoldemTableN internal zk;
    HoldemRules internal rules;
    address internal treasury = address(0x7);

    uint64 internal constant CLOCK = 30;
    uint8 internal constant SHOWDOWN = 10;
    uint8 internal constant SETTLED = 11;
    uint8 internal constant MOVE_SHOWDOWN = 7;

    function _pk(uint256 i) internal pure returns (uint256) { return 0xA11CE + i * 0x1000 + 1; }
    function _card(uint8 rank, uint8 suit) internal pure returns (uint8) { return (rank - 2) * 4 + suit; }

    function setUp() public {
        zk = new HoldemTableN(treasury);
        rules = new HoldemRules();
    }

    function _coSign(uint256 n, ChannelStateN memory s) internal view returns (bytes[] memory sigs) {
        bytes32 digest = zk.stateDigest(s);
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(_pk(i), digest);
            sigs[i] = abi.encodePacked(r, ss, v);
        }
    }

    /// Build a multiway-SHOWDOWN Holdem state: 3 seats each contributed `each`, pot = 3*each,
    /// no leftover stacks, given rake params. The seat hands are decided by the supplied board.
    function _showdownState(uint256 n, uint256 each, uint16 rakeBps, uint256 rakeCap)
        internal
        pure
        returns (HoldemRules.Holdem memory s)
    {
        s.phase = SHOWDOWN;
        s.nSeats = uint8(n);
        s.button = 0;
        s.toAct = 0xff;
        s.stacks = new uint256[](n);
        s.committed = new uint256[](n);
        s.totalContributed = new uint256[](n);
        s.folded = new bool[](n);
        s.allIn = new bool[](n);
        s.actedSinceAggression = new bool[](n);
        for (uint256 i = 0; i < n; i++) s.totalContributed[i] = each;
        s.currentBet = 0;
        s.minRaise = 0;
        s.lastAggressor = 0xff;
        s.pot = each * n;
        s.sidePots = new HoldemRules.SidePot[](0);
        s.smallBlind = 1;
        s.bigBlind = 2;
        s.rakeBps = rakeBps;
        s.rakeCap = rakeCap;
        s.stubWinner = 0xff;
        s.rakeAccrued = 0;
    }

    function _settleFromShowdown(uint16 rakeBps, uint256 rakeCap) internal {
        uint256 n = 3;
        uint256 each = 10 ether;
        uint256 buyIn = each; // each seat's whole stack went into the pot
        uint256 total = n * buyIn;

        // create table with the matching rake params
        address a0 = vm.addr(_pk(0));
        vm.deal(a0, buyIn);
        vm.prank(a0);
        bytes32 tableId = zk.create{value: buyIn}(IGameRulesN(address(rules)), buyIn, n, rakeBps, rakeCap, CLOCK, a0);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            vm.deal(ai, buyIn);
            vm.prank(ai);
            zk.join{value: buyIn}(tableId, ai);
        }
        vm.prank(a0);
        zk.start(tableId);

        // Board: A♠ K♠ 7♥ 2♦ 3♣  (suits S=0 H=1 D=2 C=3). seat 0 holds AA -> trip aces (wins).
        uint8[5] memory board =
            [_card(14, 0), _card(13, 0), _card(7, 1), _card(2, 2), _card(3, 3)];
        uint8[2][] memory holes = new uint8[2][](n);
        holes[0] = [_card(14, 1), _card(14, 2)]; // A♥ A♦ -> trips aces (best)
        holes[1] = [_card(13, 1), _card(13, 2)]; // K♥ K♦ -> trips kings
        holes[2] = [_card(7, 0), _card(7, 3)];   // 7♠ 7♣ -> trips sevens (worst)

        // Resolve the showdown via the real rules contract.
        HoldemRules.Holdem memory s0 = _showdownState(n, each, rakeBps, rakeCap);
        bytes memory move = abi.encode(MOVE_SHOWDOWN, abi.encode(holes, board));
        bytes memory out = rules.applyMove(abi.encode(s0), move);
        HoldemRules.Holdem memory settled = abi.decode(out, (HoldemRules.Holdem));
        assertEq(settled.phase, SETTLED, "reached SETTLED");
        assertEq(settled.pot, 0, "pot zeroed");
        assertEq(settled.sidePots.length, 0, "side pots zeroed");

        // Bridge: stacks -> balances, rakeAccrued carries the rake.
        uint256 sumBal = 0;
        for (uint256 i = 0; i < n; i++) sumBal += settled.stacks[i];
        assertEq(sumBal + settled.rakeAccrued, total, "showdown conserves Sigma escrow");

        ChannelStateN memory cs;
        cs.tableId = tableId;
        cs.nonce = 1;
        cs.balances = settled.stacks;
        cs.pot = 0;
        cs.sidePots = new ChannelSidePot[](0);
        cs.rakeAccrued = settled.rakeAccrued;
        cs.deckCommitment = bytes32(0);
        cs.phase = SETTLED;
        cs.gameStateHash = keccak256(out);

        bytes[] memory sigs = _coSign(n, cs);

        uint256 zkBefore = address(zk).balance;
        uint256 treBefore = treasury.balance;
        uint256 winnerBefore = vm.addr(_pk(0)).balance;

        vm.prank(a0);
        zk.settle(tableId, cs, sigs);

        // seat 0 (trip aces) wins pot - rake.
        assertEq(vm.addr(_pk(0)).balance - winnerBefore, settled.stacks[0], "winner paid balances[0]");
        assertEq(zkBefore - address(zk).balance, total, "exactly Sigma escrow left the contract");
        assertEq(treasury.balance - treBefore, settled.rakeAccrued, "treasury got the rake");
        assertEq(address(zk).balance, 0, "no residue");
        assertEq(uint8(zk.status(tableId)), uint8(HoldemTableN.Status.Settled), "settled");
    }

    function test_settle_showdown_rakeZero() public { _settleFromShowdown(0, 0); }
    function test_settle_showdown_rakeBps() public { _settleFromShowdown(250, 100 ether); } // 2.5% (MAX_RAKE_BPS), cap loose
    function test_settle_showdown_rakeCap() public { _settleFromShowdown(250, 1); } // cap bites -> rake 1 wei
}
