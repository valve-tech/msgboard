// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChannelState, ChannelStateLib} from "../../contracts/zk/ChannelState.sol";
import {ChannelStateN, SidePot, ChannelStateNLib} from "../../contracts/zk/ChannelStateN.sol";

/// Minimal external wrappers so a foundry test can exercise the *calldata*-taking
/// library functions (structHash / totalLockedCalldata): an internal library function
/// with a `calldata` parameter can only run where the argument IS calldata, which
/// requires an external call boundary — any external call built from a `memory` struct
/// gets ABI-encoded and decoded as calldata on the other side, which is exactly what we
/// want to exercise both the calldata and memory code paths side by side.
contract ChannelStateHarness {
    function structHash(ChannelState calldata s) external pure returns (bytes32) {
        return ChannelStateLib.structHash(s);
    }

    function structHashMem(ChannelState memory s) external pure returns (bytes32) {
        return ChannelStateLib.structHashMem(s);
    }

    function typehash() external pure returns (bytes32) {
        return ChannelStateLib.TYPEHASH;
    }
}

contract ChannelStateNHarness {
    function structHash(ChannelStateN calldata s) external pure returns (bytes32) {
        return ChannelStateNLib.structHash(s);
    }

    function structHashMem(ChannelStateN memory s) external pure returns (bytes32) {
        return ChannelStateNLib.structHashMem(s);
    }

    function totalLocked(ChannelStateN memory s) external pure returns (uint256) {
        return ChannelStateNLib.totalLocked(s);
    }

    function totalLockedCalldata(ChannelStateN calldata s) external pure returns (uint256) {
        return ChannelStateNLib.totalLockedCalldata(s);
    }

    function typehash() external pure returns (bytes32) {
        return ChannelStateNLib.TYPEHASH;
    }

    function sidePotTypehash() external pure returns (bytes32) {
        return ChannelStateNLib.SIDEPOT_TYPEHASH;
    }
}

contract ChannelStateUnitTest is Test {
    ChannelStateHarness internal h;
    ChannelStateNHarness internal hn;

    function setUp() public {
        h = new ChannelStateHarness();
        hn = new ChannelStateNHarness();
    }

    // ===================================================================
    // ChannelState (2-party)
    // ===================================================================

    function _base() internal pure returns (ChannelState memory s) {
        s.tableId = keccak256("table");
        s.nonce = 7;
        s.balanceA = 1_000;
        s.balanceB = 2_000;
        s.pot = 300;
        s.deckCommitment = keccak256("deck");
        s.phase = 2;
        s.gameStateHash = keccak256("gs");
    }

    function test_typehashConstant() public view {
        bytes32 expected = keccak256(
            "ChannelState(bytes32 tableId,uint64 nonce,uint256 balanceA,uint256 balanceB,uint256 pot,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash)"
        );
        assertEq(h.typehash(), expected);
    }

    function test_digestDeterministic() public view {
        assertEq(h.structHashMem(_base()), h.structHashMem(_base()));
        assertEq(h.structHash(_base()), h.structHash(_base()));
    }

    function test_calldataMatchesMemoryVariant() public view {
        ChannelState memory s = _base();
        assertEq(h.structHash(s), h.structHashMem(s));
    }

    function test_digestSensitiveToEveryField() public view {
        bytes32 d = h.structHashMem(_base());

        ChannelState memory s = _base();
        s.tableId = keccak256("table2");
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.nonce = 8;
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.balanceA = 1_001;
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.balanceB = 2_001;
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.pot = 301;
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.deckCommitment = keccak256("deck2");
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.phase = 3;
        assertTrue(h.structHashMem(s) != d);

        s = _base();
        s.gameStateHash = keccak256("gs2");
        assertTrue(h.structHashMem(s) != d);
    }

    function test_zeroStateDigestDeterministicAndDistinct() public view {
        ChannelState memory zero;
        bytes32 zeroDigest = h.structHashMem(zero);
        assertEq(zeroDigest, h.structHash(zero));
        assertTrue(zeroDigest != h.structHashMem(_base()));
    }

    function test_maxValueEdges() public view {
        ChannelState memory s = _base();
        s.nonce = type(uint64).max;
        s.phase = type(uint8).max;
        s.balanceA = type(uint256).max;
        s.balanceB = type(uint256).max;
        s.pot = type(uint256).max;
        // Just needs to not revert and to be internally consistent across variants.
        assertEq(h.structHash(s), h.structHashMem(s));
    }

    // ===================================================================
    // ChannelStateN (N-party)
    // ===================================================================

    function _baseN(uint256 nSeats, uint256 nPots) internal pure returns (ChannelStateN memory s) {
        s.tableId = keccak256("tableN");
        s.nonce = 5;
        s.balances = new uint256[](nSeats);
        for (uint256 i = 0; i < nSeats; i++) {
            s.balances[i] = (i + 1) * 100;
        }
        s.pot = 50;
        s.sidePots = new SidePot[](nPots);
        for (uint256 i = 0; i < nPots; i++) {
            s.sidePots[i] = SidePot({amount: (i + 1) * 10, eligibleMask: (1 << (i + 1)) - 1});
        }
        s.rakeAccrued = 3;
        s.deckCommitment = keccak256("deckN");
        s.phase = 1;
        s.gameStateHash = keccak256("gsN");
    }

    function test_typehashConstants() public view {
        bytes32 expectedSidePot = keccak256("SidePot(uint256 amount,uint256 eligibleMask)");
        assertEq(hn.sidePotTypehash(), expectedSidePot);

        bytes32 expectedChannelStateN = keccak256(
            "ChannelStateN(bytes32 tableId,uint64 nonce,uint256[] balances,uint256 pot,SidePot[] sidePots,uint256 rakeAccrued,bytes32 deckCommitment,uint8 phase,bytes32 gameStateHash)SidePot(uint256 amount,uint256 eligibleMask)"
        );
        assertEq(hn.typehash(), expectedChannelStateN);
    }

    /// Digest determinism + calldata/memory parity across varying seat counts and
    /// side-pot counts — exercises both zero-iteration and multi-iteration paths of
    /// the internal `_hashBalances`/`_hashSidePots` loops.
    function test_digestDeterministic_variousSeatAndPotCounts() public view {
        uint256[4] memory seatCounts = [uint256(0), 1, 2, 9];
        uint256[3] memory potCounts = [uint256(0), 1, 3];

        for (uint256 i = 0; i < seatCounts.length; i++) {
            for (uint256 j = 0; j < potCounts.length; j++) {
                ChannelStateN memory s = _baseN(seatCounts[i], potCounts[j]);
                bytes32 dMem = hn.structHashMem(s);
                assertEq(dMem, hn.structHashMem(_baseN(seatCounts[i], potCounts[j])));
                assertEq(dMem, hn.structHash(s));
            }
        }
    }

    function test_digestSensitiveToBalanceElement() public view {
        ChannelStateN memory s = _baseN(3, 1);
        bytes32 d = hn.structHashMem(s);
        s.balances[1] = s.balances[1] + 1;
        assertTrue(hn.structHashMem(s) != d);
    }

    function test_digestSensitiveToBalancesLength() public view {
        bytes32 dThree = hn.structHashMem(_baseN(3, 1));
        bytes32 dTwo = hn.structHashMem(_baseN(2, 1));
        assertTrue(dThree != dTwo);
    }

    function test_digestSensitiveToSidePotAmount() public view {
        ChannelStateN memory s = _baseN(2, 2);
        bytes32 d = hn.structHashMem(s);
        s.sidePots[0].amount += 1;
        assertTrue(hn.structHashMem(s) != d);
    }

    function test_digestSensitiveToSidePotMask() public view {
        ChannelStateN memory s = _baseN(2, 2);
        bytes32 d = hn.structHashMem(s);
        s.sidePots[1].eligibleMask += 1;
        assertTrue(hn.structHashMem(s) != d);
    }

    function test_digestSensitiveToSidePotsLength() public view {
        bytes32 dTwoPots = hn.structHashMem(_baseN(2, 2));
        bytes32 dThreePots = hn.structHashMem(_baseN(2, 3));
        assertTrue(dTwoPots != dThreePots);
    }

    function test_digestSensitiveToScalarFields() public view {
        bytes32 d = hn.structHashMem(_baseN(2, 2));

        ChannelStateN memory s = _baseN(2, 2);
        s.tableId = keccak256("tableN2");
        assertTrue(hn.structHashMem(s) != d);

        s = _baseN(2, 2);
        s.nonce = 6;
        assertTrue(hn.structHashMem(s) != d);

        s = _baseN(2, 2);
        s.pot = 51;
        assertTrue(hn.structHashMem(s) != d);

        s = _baseN(2, 2);
        s.rakeAccrued = 4;
        assertTrue(hn.structHashMem(s) != d);

        s = _baseN(2, 2);
        s.deckCommitment = keccak256("deckN2");
        assertTrue(hn.structHashMem(s) != d);

        s = _baseN(2, 2);
        s.phase = 2;
        assertTrue(hn.structHashMem(s) != d);

        s = _baseN(2, 2);
        s.gameStateHash = keccak256("gsN2");
        assertTrue(hn.structHashMem(s) != d);
    }

    function test_emptyArraysDigestConsistentAcrossVariants() public view {
        ChannelStateN memory s = _baseN(0, 0);
        bytes32 dMem = hn.structHashMem(s);
        bytes32 dCalldata = hn.structHash(s);
        assertEq(dMem, dCalldata);
        // Distinct from a state that has seats/pots, i.e. the empty-array encoding
        // isn't accidentally colliding with the non-empty one.
        assertTrue(dMem != hn.structHashMem(_baseN(1, 1)));
    }

    /// Σ balances + pot + Σ sidePots.amount + rakeAccrued, matching both the memory
    /// and calldata variants of the conservation-sum helper, across seat/pot counts
    /// including the zero-iteration loop edge for each internal `for` loop.
    function test_totalLockedConservationFormula() public view {
        uint256[4] memory seatCounts = [uint256(0), 1, 2, 9];
        uint256[3] memory potCounts = [uint256(0), 1, 3];

        for (uint256 i = 0; i < seatCounts.length; i++) {
            for (uint256 j = 0; j < potCounts.length; j++) {
                ChannelStateN memory s = _baseN(seatCounts[i], potCounts[j]);

                uint256 expected = s.pot + s.rakeAccrued;
                for (uint256 k = 0; k < s.balances.length; k++) {
                    expected += s.balances[k];
                }
                for (uint256 k = 0; k < s.sidePots.length; k++) {
                    expected += s.sidePots[k].amount;
                }

                assertEq(hn.totalLocked(s), expected);
                assertEq(hn.totalLockedCalldata(s), expected);
            }
        }
    }

    function test_totalLockedZeroSeatsZeroPots() public view {
        ChannelStateN memory s = _baseN(0, 0);
        assertEq(hn.totalLocked(s), s.pot + s.rakeAccrued);
        assertEq(hn.totalLockedCalldata(s), s.pot + s.rakeAccrued);
    }
}
