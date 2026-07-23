// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CoinFlip} from "../../contracts/CoinFlip.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

contract CoinFlipFuzzTest is Test {
    CoinFlip internal coin;
    MockRandom internal rnd;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    uint256 internal constant STAKE = 1 ether;
    bytes32 internal constant HEATED_SIG = keccak256("Heated(bytes32,bytes32)");
    bytes32 internal constant PAIRED_SIG = keccak256("Paired(bytes32,address,address,uint256)");

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

    /// Pair heads+tails; return (flipId, heat key) parsed from the Paired/Heated events.
    function _pair(address heads, address tails) internal returns (bytes32 flipId, bytes32 key) {
        vm.deal(heads, STAKE);
        vm.deal(tails, STAKE);
        vm.prank(heads);
        coin.enterAndMatch{value: STAKE}(0, subset, locs); // queues (locations ignored)
        vm.recordLogs();
        vm.prank(tails);
        coin.enterAndMatch{value: STAKE}(1, subset, locs); // pairs + heats
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == PAIRED_SIG) flipId = logs[i].topics[1];
            if (logs[i].topics[0] == HEATED_SIG) key = logs[i].topics[2];
        }
        require(flipId != bytes32(0) && key != bytes32(0), "pairing failed");
    }

    /// For any seed, the parity-selected winner receives exactly 2*STAKE, the loser nothing, and
    /// the contract is left with no dust — the two escrowed stakes are fully conserved.
    function testFuzz_parityWinnerTakesPot(uint256 seedWord) public {
        address heads = address(0x111);
        address tails = address(0x222);
        (, bytes32 key) = _pair(heads, tails);

        address winner = (seedWord & 1) == 0 ? heads : tails;
        address loser = (seedWord & 1) == 0 ? tails : heads;
        uint256 winnerBefore = winner.balance;
        uint256 loserBefore = loser.balance;

        rnd.pushCast(address(coin), key, bytes32(seedWord));

        assertEq(winner.balance - winnerBefore, STAKE * 2, "winner gets the whole pot");
        assertEq(loser.balance, loserBefore, "loser gets nothing back");
        assertEq(address(coin).balance, 0, "no dust left in the contract");
    }

    /// Regression for the security-review fix: a flip whose seed finalized cannot be unwound by
    /// refundStale even past the stale timeout (it would escape a decided outcome). claim is the
    /// only resolution, and it pays the parity winner. Fuzzed over the seed.
    function testFuzz_settledFlipResolvesByClaimNotRefund(uint256 seedWord) public {
        address heads = address(0x333);
        address tails = address(0x444);
        (bytes32 flipId, bytes32 key) = _pair(heads, tails);

        // finalize the seed WITHOUT delivering the push, so the flip is seed-finalized-but-Pending
        rnd.setSeed(key, bytes32(uint256(seedWord) | 1)); // | 1 guarantees a non-zero seed

        vm.roll(block.number + 201); // past STALE_BLOCKS
        vm.expectRevert(CoinFlip.TooEarly.selector);
        coin.refundStale(flipId); // must refuse: the seed is finalized

        address winner = ((uint256(seedWord) | 1) & 1) == 0 ? heads : tails; // odd seed => tails
        uint256 before = winner.balance;
        coin.claim(flipId);
        assertEq(winner.balance - before, STAKE * 2, "claim pays the parity winner");
        assertEq(address(coin).balance, 0, "no dust");
    }
}
