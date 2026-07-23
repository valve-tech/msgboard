// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Raffle} from "../../contracts/Raffle.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Drives a Raffle through randomized commit/cancel/arm/draw/reveal/finalise/refund
/// sequences, tracking every wei that enters and leaves with ghost variables. Invalid orderings
/// revert and are absorbed (fail_on_revert = false), so only successful state transitions move the
/// ghosts. The handler is the sole player; validators are external addresses that receive
/// no-contest payouts. Ghost accounting:
///   ghostIn  += STAKE on each successful commit
///   ghostOut += STAKE on each successful cancel and refundTicket
///   ghostOut += settledPot once per successful finalise (whole pot leaves — winner+fee or split)
contract RaffleHandler is Test {
    Raffle public raffle;
    MockRandom public rnd;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant THRESHOLD = 3;
    uint256 internal constant PERIOD = 5;

    uint256 public ghostIn;
    uint256 public ghostOut;

    uint256[] public tickets;                  // every ticket id ever created
    mapping(uint256 => uint256) public guessOf;
    mapping(uint256 => bytes32) public saltOf;
    mapping(uint256 => bytes32) public roundOf;
    mapping(uint256 => bool) public consumedTicket;   // cancelled or refunded
    mapping(bytes32 => bool) public finalisedRound;

    constructor(Raffle _raffle, MockRandom _rnd, address[] memory _subset, PreimageLocation.Info[] memory _locs) {
        raffle = _raffle;
        rnd = _rnd;
        for (uint256 i = 0; i < _subset.length; i++) {
            subset.push(_subset[i]);
            locs.push(_locs[i]);
        }
        vm.deal(address(this), 1_000_000 ether);
    }

    function _tuple() internal view returns (bytes32) {
        return keccak256(abi.encode(STAKE, THRESHOLD, PERIOD, keccak256(abi.encode(subset))));
    }

    function _status(bytes32 r) internal view returns (Raffle.Status s) {
        ( , , , , , , , s, , , , , , , ) = raffle.rounds(r);
    }
    function _key(bytes32 r) internal view returns (bytes32 k) {
        ( , , , , , , , , k, , , , , , ) = raffle.rounds(r);
    }
    function _settledPot(bytes32 r) internal view returns (uint256 p) {
        ( , , , , , , , , , , , , , , p) = raffle.rounds(r);
    }

    function commit(uint256 guessSeed) public {
        uint256 guess = bound(guessSeed, 1, 256);
        bytes32 salt = keccak256(abi.encode(guessSeed));
        try raffle.commit{value: STAKE}(STAKE, THRESHOLD, PERIOD, subset, keccak256(abi.encode(guess, salt, address(this))))
            returns (uint256 tid)
        {
            ghostIn += STAKE;
            guessOf[tid] = guess;
            saltOf[tid] = salt;
            roundOf[tid] = raffle.activeRound(_tuple());
            tickets.push(tid);
        } catch {}
    }

    function cancel(uint256 idx) public {
        if (tickets.length == 0) return;
        uint256 tid = tickets[bound(idx, 0, tickets.length - 1)];
        try raffle.cancel(tid) {
            ghostOut += STAKE;
            consumedTicket[tid] = true;
        } catch {}
    }

    function arm(uint256 idx) public {
        if (tickets.length == 0) return;
        bytes32 r = roundOf[tickets[bound(idx, 0, tickets.length - 1)]];
        if (_status(r) == Raffle.Status.Filling) vm.roll(block.number + PERIOD); // try to satisfy the period gate
        try raffle.arm(r, locs) {} catch {}
    }

    function draw(uint256 idx, uint256 seedWord) public {
        if (tickets.length == 0) return;
        bytes32 r = roundOf[tickets[bound(idx, 0, tickets.length - 1)]];
        if (_status(r) == Raffle.Status.Drawing) {
            try rnd.pushCast(address(raffle), _key(r), bytes32(seedWord)) {} catch {}
        }
    }

    function reveal(uint256 idx) public {
        if (tickets.length == 0) return;
        uint256 tid = tickets[bound(idx, 0, tickets.length - 1)];
        try raffle.reveal(tid, guessOf[tid], saltOf[tid]) {} catch {}
    }

    function finalise(uint256 idx) public {
        if (tickets.length == 0) return;
        bytes32 r = roundOf[tickets[bound(idx, 0, tickets.length - 1)]];
        if (_status(r) == Raffle.Status.Claiming) vm.roll(block.number + 101); // pass the claim window
        uint256 pot = _settledPot(r);
        try raffle.finalise(r) {
            if (!finalisedRound[r]) {
                ghostOut += pot;
                finalisedRound[r] = true;
            }
        } catch {}
    }

    function refund(uint256 idx) public {
        if (tickets.length == 0) return;
        uint256 tid = tickets[bound(idx, 0, tickets.length - 1)];
        bytes32 r = roundOf[tid];
        if (_status(r) == Raffle.Status.Drawing) vm.roll(block.number + 201); // pass the stale timeout
        try raffle.refundTicket(tid) {
            ghostOut += STAKE;
            consumedTicket[tid] = true;
        } catch {}
    }
}

contract RaffleInvariantTest is StdInvariant, Test {
    Raffle internal raffle;
    MockRandom internal rnd;
    RaffleHandler internal handler;

    function setUp() public {
        rnd = new MockRandom();
        raffle = new Raffle(address(rnd));
        address[] memory subset = new address[](3);
        PreimageLocation.Info[] memory locs = new PreimageLocation.Info[](3);
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x2000 + i));
            raffle.addValidator(v);
            subset[i] = v;
            locs[i] = PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            });
        }
        handler = new RaffleHandler(raffle, rnd, subset, locs);
        targetContract(address(handler));
    }

    /// Every wei is conserved: the contract holds exactly what came in minus what went out.
    function invariant_valueConservation() public view {
        assertEq(address(raffle).balance, handler.ghostIn() - handler.ghostOut(), "no wei stuck or conjured");
    }

    /// The contract can never owe more than it holds (no over-commitment of escrow).
    function invariant_balanceNeverNegativeFlow() public view {
        assertGe(handler.ghostIn(), handler.ghostOut(), "out never exceeds in");
    }
}
