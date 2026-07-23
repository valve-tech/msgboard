// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "./GameBase.sol";
import {IRandom} from "./implementations/IRandom.sol";
import {PreimageLocation} from "./PreimageLocation.sol";

/// @notice Closest-guess raffle on validator-only entropy. Players commit a hidden, address-bound
/// guess in [1..256] at an equal per-guess stake into a round keyed by its parameter tuple. When
/// the round has at least its threshold of commits and a period has elapsed, an operator arms it
/// (heating the declared validator subset through GameBase's bound heat). A validator cast sets the
/// seed; the contract records the draw and opens a claim window in which committers reveal; the
/// closest revealed guess takes the pot less the fee. Non-revealers forfeit; nothing a player does
/// can stall, abort, or grind the draw.
contract Raffle is GameBase {
    error BadParams();
    error NotFilling();
    error ThresholdNotMet();
    error PeriodNotElapsed();
    error NotTicketOwner();
    error TicketInactive();
    error WrongRoundState();
    error WindowClosed();
    error WindowOpen();
    error BadReveal();
    error AlreadyRevealed();
    error GuessOutOfRange();
    error TooEarly();
    error NothingToRefund();
    error BadFee();

    event RoundOpened(bytes32 indexed roundId, uint256 stake, uint256 threshold, uint256 period, bytes32 subsetHash);
    event Committed(uint256 indexed ticketId, bytes32 indexed roundId, address indexed player, bytes32 commitment);
    event TicketCancelled(uint256 indexed ticketId);
    event Armed(bytes32 indexed roundId, bytes32 indexed key);
    event Drawn(bytes32 indexed roundId, uint256 draw, uint256 claimDeadline);
    event Revealed(uint256 indexed ticketId, bytes32 indexed roundId, uint256 guess, uint256 distance, bool leading);
    event Finalised(bytes32 indexed roundId, address indexed winner, uint256 payout, uint256 fee);
    event NoContest(bytes32 indexed roundId, uint256 potPerValidator);
    event TicketRefunded(uint256 indexed ticketId);

    enum Status { None, Filling, Drawing, Claiming, Paid, Refunded }

    struct Round {
        uint256 stake;
        uint256 threshold;
        uint256 period;
        bytes32 subsetHash;
        uint256 createdAtBlock;
        uint256 commitCount;
        uint256 pot;
        Status status;
        bytes32 key;
        uint256 armedAtBlock;
        uint256 draw;
        uint256 claimDeadline;
        uint256 bestTicket;
        uint256 bestDistance;
        uint256 settledPot;
    }

    struct Ticket {
        bytes32 roundId;
        address player;
        bytes32 commitment;
        uint256 committedAtBlock;
        bool active;
        bool revealed;
    }

    uint256 public constant RANGE = 256; // draws and guesses are in [1..256]
    uint256 public constant CLAIM_BLOCKS = 100;
    uint256 public constant BIPS = 10_000;

    /// @notice owner-adjustable rake, in basis points, default zero; a percentage so a nonzero
    /// value self-taxes raffle flooding.
    uint256 public feeBips;
    address public feeRecipient;

    mapping(bytes32 roundId => Round) public rounds;
    mapping(bytes32 roundId => address[] subset) internal _roundSubset;
    mapping(uint256 ticketId => Ticket) public tickets;
    uint256 public nextTicket;

    /// @notice the currently-filling round for a parameter tuple, so commits with the same tuple
    /// concentrate into one round; cleared when that round arms so the next commit opens a fresh one.
    mapping(bytes32 tupleHash => bytes32 roundId) public activeRound;
    uint256 internal _roundNonce;

    constructor(address _random) GameBase(_random) {
        feeRecipient = msg.sender;
    }

    function setFee(uint256 newFeeBips, address newRecipient) external onlyOwner {
        if (newFeeBips > BIPS) revert BadFee();
        feeBips = newFeeBips;
        feeRecipient = newRecipient;
    }

    /// @notice Commit a hidden guess into the round for these parameters at the sent stake.
    /// commitment = keccak256(abi.encode(guess, salt, msg.sender)). Opens a new round if none is
    /// filling for this tuple.
    function commit(
        uint256 stake,
        uint256 threshold,
        uint256 period,
        address[] calldata validatorSubset,
        bytes32 commitment
    ) external payable returns (uint256 ticketId) {
        if (stake == 0 || threshold == 0 || period == 0) revert BadParams();
        _take(stake);
        _validateSubset(validatorSubset);
        bytes32 subsetHash = keccak256(abi.encode(validatorSubset));
        bytes32 tupleHash = keccak256(abi.encode(stake, threshold, period, subsetHash));

        bytes32 roundId = activeRound[tupleHash];
        if (roundId == bytes32(0) || rounds[roundId].status != Status.Filling) {
            roundId = keccak256(abi.encode(address(this), ++_roundNonce, tupleHash));
            rounds[roundId] = Round({
                stake: stake,
                threshold: threshold,
                period: period,
                subsetHash: subsetHash,
                createdAtBlock: block.number,
                commitCount: 0,
                pot: 0,
                status: Status.Filling,
                key: bytes32(0),
                armedAtBlock: 0,
                draw: 0,
                claimDeadline: 0,
                bestTicket: 0,
                bestDistance: 0,
                settledPot: 0
            });
            _roundSubset[roundId] = validatorSubset;
            activeRound[tupleHash] = roundId;
            emit RoundOpened(roundId, stake, threshold, period, subsetHash);
        }

        Round storage round = rounds[roundId];
        ticketId = ++nextTicket;
        tickets[ticketId] = Ticket({
            roundId: roundId,
            player: msg.sender,
            commitment: commitment,
            committedAtBlock: block.number,
            active: true,
            revealed: false
        });
        unchecked {
            ++round.commitCount;
            round.pot += stake;
        }
        emit Committed(ticketId, roundId, msg.sender, commitment);
    }

    /// @notice Reclaim a still-waiting ticket while its round is filling (the per-ticket escape).
    function cancel(uint256 ticketId) external {
        Ticket storage ticket = tickets[ticketId];
        if (ticket.player != msg.sender) revert NotTicketOwner();
        if (!ticket.active) revert TicketInactive();
        Round storage round = rounds[ticket.roundId];
        if (round.status != Status.Filling) revert WrongRoundState();
        ticket.active = false;
        unchecked {
            --round.commitCount;
            round.pot -= round.stake;
        }
        emit TicketCancelled(ticketId);
        _refund(ticket.player, round.stake);
    }

    function roundSubset(bytes32 roundId) external view returns (address[] memory) {
        return _roundSubset[roundId];
    }

    /// @notice Operator step: heat the round's declared validator subset once it is at threshold and
    /// a period has elapsed. Permissionless, but bound — _heatBound permits only locations matching
    /// the declared subset, and the threshold and filling-status checks make arming one-shot.
    function arm(bytes32 roundId, PreimageLocation.Info[] calldata validatorLocations) external {
        Round storage round = rounds[roundId];
        if (round.status != Status.Filling) revert NotFilling();
        if (round.commitCount < round.threshold) revert ThresholdNotMet();
        if (block.number < round.createdAtBlock + round.period) revert PeriodNotElapsed();

        round.status = Status.Drawing;
        round.armedAtBlock = block.number;
        round.settledPot = round.pot;
        // the next commit for this tuple opens a fresh round
        bytes32 tupleHash = keccak256(abi.encode(round.stake, round.threshold, round.period, round.subsetHash));
        if (activeRound[tupleHash] == roundId) {
            activeRound[tupleHash] = bytes32(0);
        }

        bytes32 key = _heatBound(_roundSubset[roundId], validatorLocations);
        round.key = key;
        instanceByKey[key] = roundId;
        emit Armed(roundId, key);
    }

    /// @notice Record the draw and open the claim window (does not pay). Invoked by onCast (push)
    /// via GameBase and by recordDraw (pull fallback).
    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage round = rounds[roundId];
        if (round.status != Status.Drawing) revert WrongRoundState();
        round.status = Status.Claiming;
        round.draw = 1 + (uint256(seed) % RANGE);
        round.claimDeadline = block.number + CLAIM_BLOCKS;
        emit Drawn(roundId, round.draw, round.claimDeadline);
    }

    /// @notice Reveal a committed guess during the claim window. Verifies the commitment against
    /// (guess, salt, msg.sender) — the address binding is what stops a front-runner replaying a
    /// revealed guess from the mempool. Overwrites the provisional winner if strictly closer, ties
    /// broken by earliest commit block then ticket id (so the winner is independent of reveal order).
    function reveal(uint256 ticketId, uint256 guess, bytes32 salt) external {
        Ticket storage ticket = tickets[ticketId];
        Round storage round = rounds[ticket.roundId];
        if (round.status != Status.Claiming) revert WrongRoundState();
        if (block.number > round.claimDeadline) revert WindowClosed();
        if (!ticket.active) revert TicketInactive();
        if (ticket.revealed) revert AlreadyRevealed();
        if (guess < 1 || guess > RANGE) revert GuessOutOfRange();
        if (keccak256(abi.encode(guess, salt, msg.sender)) != ticket.commitment) revert BadReveal();

        ticket.revealed = true;
        uint256 distance = guess > round.draw ? guess - round.draw : round.draw - guess;

        bool leading;
        if (round.bestTicket == 0) {
            leading = true;
        } else if (distance < round.bestDistance) {
            leading = true;
        } else if (distance == round.bestDistance) {
            Ticket storage best = tickets[round.bestTicket];
            if (ticket.committedAtBlock < best.committedAtBlock) {
                leading = true;
            } else if (ticket.committedAtBlock == best.committedAtBlock && ticketId < round.bestTicket) {
                leading = true;
            }
        }
        if (leading) {
            round.bestTicket = ticketId;
            round.bestDistance = distance;
        }
        emit Revealed(ticketId, ticket.roundId, guess, distance, leading);
    }

    /// @notice Pull fallback when the onCast push did not complete though the seed is finalized.
    function recordDraw(bytes32 roundId) external {
        Round storage round = rounds[roundId];
        if (round.status != Status.Drawing) revert WrongRoundState();
        bytes32 seed = IRandom(random).randomness(round.key).seed;
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }

    /// @notice After the claim window, pay the closest revealer the pot less the fee; if nobody
    /// revealed, route the pot to the round's contributing validators (the no-contest case — the
    /// seed finalised, so no validator was chopped). Non-revealers' stakes are part of the pot.
    function finalise(bytes32 roundId) external {
        Round storage round = rounds[roundId];
        if (round.status != Status.Claiming) revert WrongRoundState();
        if (block.number <= round.claimDeadline) revert WindowOpen();
        round.status = Status.Paid;

        uint256 pot = round.settledPot;
        if (round.bestTicket == 0) {
            address[] storage subset = _roundSubset[roundId];
            uint256 n = subset.length;
            uint256 share = pot / n;
            for (uint256 i = 0; i < n; ++i) {
                _pay(subset[i], i + 1 == n ? pot - share * (n - 1) : share);
            }
            emit NoContest(roundId, share);
            return;
        }

        uint256 fee = (pot * feeBips) / BIPS;
        address winner = tickets[round.bestTicket].player;
        emit Finalised(roundId, winner, pot - fee, fee);
        if (fee > 0) _pay(feeRecipient, fee);
        _pay(winner, pot - fee);
    }

    /// @notice Liveness exit: when an armed round's seed never finalised (chopped or stale), each
    /// committer reclaims their own ticket's stake. Pull, per-ticket, so a large round needs no push.
    function refundTicket(uint256 ticketId) external {
        Ticket storage ticket = tickets[ticketId];
        if (ticket.player != msg.sender) revert NotTicketOwner();
        if (!ticket.active) revert TicketInactive();
        Round storage round = rounds[ticket.roundId];
        if (round.status != Status.Drawing) revert WrongRoundState();
        bool seedMissing = IRandom(random).randomness(round.key).seed == bytes32(0);
        if (!seedMissing) revert TooEarly();
        if (!choppedInstance[ticket.roundId] && !_isStale(round.armedAtBlock)) revert TooEarly();
        ticket.active = false;
        emit TicketRefunded(ticketId);
        _refund(ticket.player, round.stake);
    }
}
