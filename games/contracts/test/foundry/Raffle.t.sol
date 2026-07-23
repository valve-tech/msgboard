// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Raffle} from "../../contracts/Raffle.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @dev Shared setup: a Raffle on a MockRandom with a 3-validator allowlisted subset and
/// binding-correct heat locations. MockRandom.heat consumes no real preimages, so rounds can be
/// armed and driven freely.
contract RaffleBase is Test {
    Raffle internal raffle;
    MockRandom internal rnd;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant THRESHOLD = 3;
    uint256 internal constant PERIOD = 5;

    function _setUpGame() internal {
        rnd = new MockRandom();
        raffle = new Raffle(address(rnd)); // this contract is owner
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x1000 + i));
            raffle.addValidator(v);
            subset.push(v);
            locs.push(PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            }));
        }
    }

    function _commitment(uint256 guess, bytes32 salt, address player) internal pure returns (bytes32) {
        return keccak256(abi.encode(guess, salt, player));
    }

    function _tupleHash(uint256 stake) internal view returns (bytes32) {
        return keccak256(abi.encode(stake, THRESHOLD, PERIOD, keccak256(abi.encode(subset))));
    }

    // Round tuple field readers (indexes per the struct: 8=key, 10=draw, 12=bestTicket).
    function _key(bytes32 roundId) internal view returns (bytes32 k) {
        ( , , , , , , , , k, , , , , , ) = raffle.rounds(roundId);
    }
    function _draw(bytes32 roundId) internal view returns (uint256 d) {
        ( , , , , , , , , , , d, , , , ) = raffle.rounds(roundId);
    }
    function _bestTicket(bytes32 roundId) internal view returns (uint256 b) {
        ( , , , , , , , , , , , , b, , ) = raffle.rounds(roundId);
    }
}

contract RaffleFuzzTest is RaffleBase {
    function setUp() public {
        _setUpGame();
    }

    /// The draw is always reduced into [1, 256] for any seed word.
    function testFuzz_drawAlwaysInRange(uint256 seedWord) public {
        for (uint256 i = 0; i < 3; i++) {
            address q = address(uint160(0xAB00 + i));
            vm.deal(q, STAKE);
            vm.prank(q);
            raffle.commit{value: STAKE}(STAKE, THRESHOLD, PERIOD, subset, _commitment(i + 1, bytes32(i), q));
        }
        bytes32 roundId = raffle.activeRound(_tupleHash(STAKE));
        vm.roll(block.number + PERIOD);
        raffle.arm(roundId, locs);
        rnd.pushCast(address(raffle), _key(roundId), bytes32(seedWord));

        uint256 draw = _draw(roundId);
        assertGe(draw, 1, "draw >= 1");
        assertLe(draw, 256, "draw <= 256");
        assertEq(draw, 1 + (seedWord % 256), "draw == 1 + seed % 256");
    }

    /// After all reveals the on-chain winner is the closest guess; ties (here, same commit block)
    /// resolve to the lowest ticket id — independent of reveal order. Fuzzes guesses and seed.
    function testFuzz_winnerIsClosest(uint256 seedWord, uint8 g0, uint8 g1, uint8 g2) public {
        uint256[3] memory guesses =
            [uint256(bound(g0, 1, 256)), uint256(bound(g1, 1, 256)), uint256(bound(g2, 1, 256))];
        address[3] memory players = [address(0xA1), address(0xA2), address(0xA3)];
        bytes32[3] memory salts = [bytes32(uint256(11)), bytes32(uint256(22)), bytes32(uint256(33))];

        for (uint256 i = 0; i < 3; i++) {
            vm.deal(players[i], STAKE);
            vm.prank(players[i]);
            raffle.commit{value: STAKE}(STAKE, THRESHOLD, PERIOD, subset, _commitment(guesses[i], salts[i], players[i]));
        }
        bytes32 roundId = raffle.activeRound(_tupleHash(STAKE));
        vm.roll(block.number + PERIOD);
        raffle.arm(roundId, locs);
        rnd.pushCast(address(raffle), _key(roundId), bytes32(seedWord));
        uint256 draw = _draw(roundId);

        uint256[3] memory order = [uint256(2), 0, 1]; // scrambled reveal order
        for (uint256 k = 0; k < 3; k++) {
            uint256 i = order[k];
            vm.prank(players[i]);
            raffle.reveal(i + 1, guesses[i], salts[i]); // ticket ids 1,2,3
        }

        uint256 bestTicket;
        uint256 bestDist = type(uint256).max;
        for (uint256 i = 0; i < 3; i++) {
            uint256 d = guesses[i] > draw ? guesses[i] - draw : draw - guesses[i];
            if (d < bestDist) { bestDist = d; bestTicket = i + 1; } // strict < => lowest id on tie
        }
        assertEq(_bestTicket(roundId), bestTicket, "on-chain winner matches closest-guess oracle");
    }
}
