// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRules} from "./IGameRules.sol";

/// @notice Pure mirror of @gibs/hilo-war src/rules.ts applyMove — consulted only by
/// ZkTable's dispute machine. The TS module is normative; test/HiLoWarParity.test.ts
/// fuzzes the two against each other. Encodings are the canonical abi tuples shared
/// with examples/games/hilo-war/src/encoding.ts.
/// @dev Trust boundary: the caller (ZkTable) only ever passes a `gameState`/`move`
/// encoding that hashes to a state both players co-signed, so this contract trusts
/// structural validity (well-formed, semantically-reachable states) and enforces only
/// *transition* legality — it is NOT a standalone validator of arbitrary bytes.
contract HiLoWarRules is IGameRules {
    error WrongPhase();
    error WrongSeat();
    error AlreadyMoved();
    error CommitMismatch();
    error BadCard();
    error IllegalMove();

    uint8 internal constant PHASE_SETUP = 0;
    uint8 internal constant PHASE_DEAL = 1;
    uint8 internal constant PHASE_BET_COMMIT = 2;
    uint8 internal constant PHASE_BET_OPEN = 3;
    uint8 internal constant PHASE_CALL_OR_FOLD = 4;
    uint8 internal constant PHASE_SHOWDOWN = 5;
    uint8 internal constant PHASE_FLIP_DONE = 6;
    uint8 internal constant PHASE_SETTLED = 7;

    uint8 internal constant SEAT_A = 1;
    uint8 internal constant SEAT_B = 2;
    uint8 internal constant BET_RAISE = 1;
    uint8 internal constant BET_HOLD = 2;

    uint8 internal constant MOVE_DEAL_DONE = 0;
    uint8 internal constant MOVE_BET_COMMIT = 1;
    uint8 internal constant MOVE_BET_OPEN = 2;
    uint8 internal constant MOVE_CALL = 3;
    uint8 internal constant MOVE_FOLD = 4;
    uint8 internal constant MOVE_SHOWDOWN = 5;

    uint8 internal constant MAX_CARD = 51;
    uint8 internal constant CARDS_PER_RANK = 4;

    /// Mirrors encoding.ts GAME_STATE_ABI field-for-field.
    struct HiLo {
        uint8 phase;
        uint32 deckIndex;
        uint256 ante;
        uint256 pot;
        uint256 warPot;
        uint256 contributedA;
        uint256 contributedB;
        bytes32 commitA;
        bytes32 commitB;
        uint8 betA;
        uint8 betB;
        uint8 raiser;
        uint8 resultWinner;
        uint256 resultAmount;
        bool resultSet;
        bool foldedCardHidden;
    }

    address public immutable revealVerifierAddr;
    /// @dev reserved for future shuffle-proof disputes; not yet consulted
    address public immutable shuffleVerifierAddr;

    constructor(address revealVerifier_, address shuffleVerifier_) {
        revealVerifierAddr = revealVerifier_;
        shuffleVerifierAddr = shuffleVerifier_;
    }

    function gameId() external pure returns (uint16) { return 1; }
    function revealVerifier() external view returns (address) { return revealVerifierAddr; }

    function hashGameState(bytes calldata gameState) external pure returns (bytes32) {
        return keccak256(gameState);
    }

    function isFinal(uint8 phase) external pure returns (bool) {
        return phase == PHASE_SETTLED;
    }

    /// bit0 = A owes the next protocol action, bit1 = B.
    function whoseTurn(bytes calldata gameState) external pure returns (uint8 mask) {
        HiLo memory s = abi.decode(gameState, (HiLo));
        if (s.phase == PHASE_SETTLED) return 0;
        if (s.phase == PHASE_BET_COMMIT) {
            if (s.commitA == bytes32(0)) mask |= 1;
            if (s.commitB == bytes32(0)) mask |= 2;
        } else if (s.phase == PHASE_BET_OPEN) {
            if (s.betA == 0) mask |= 1;
            if (s.betB == 0) mask |= 2;
        } else if (s.phase == PHASE_CALL_OR_FOLD) {
            // `raiser` being a valid seat (SEAT_A/SEAT_B) is a phase invariant here:
            // CALL_OR_FOLD is only reachable through a co-signed BET_OPEN resolution, and
            // ZkTable only passes contested encodings that hash to such a co-signed state
            // (see the trust-boundary note in the header). No revert/guard — a revert here
            // could surprise the Task 8 dispute machine.
            mask = s.raiser == SEAT_A ? 2 : 1; // the non-raiser owes call/fold
        } else {
            // SETUP / DEAL / SHOWDOWN / FLIP_DONE: both parties owe protocol
            // progress (shares or the next co-signed state).
            mask = 3;
        }
    }

    function applyMove(bytes calldata gameState, bytes calldata move) external pure returns (bytes memory) {
        HiLo memory s = abi.decode(gameState, (HiLo));
        (uint8 kind, bytes memory payload) = abi.decode(move, (uint8, bytes));
        if (s.phase == PHASE_FLIP_DONE || s.phase == PHASE_SETTLED) revert WrongPhase();

        if (kind == MOVE_DEAL_DONE) {
            if (s.phase != PHASE_DEAL) revert WrongPhase();
            // rules.ts DEAL_DONE ASSIGNS pot = 2*ante, contributed = {A: ante, B: ante}
            // (not +=). From initialFlipState (pot/contributed = 0) the result is identical,
            // but we mirror the assignment exactly for parity over arbitrary states.
            s.pot = 2 * s.ante;
            s.contributedA = s.ante;
            s.contributedB = s.ante;
            s.phase = PHASE_BET_COMMIT;
        } else if (kind == MOVE_BET_COMMIT) {
            if (s.phase != PHASE_BET_COMMIT) revert WrongPhase();
            (uint8 by, bytes32 commitment) = abi.decode(payload, (uint8, bytes32));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (by == SEAT_A) {
                if (s.commitA != bytes32(0)) revert AlreadyMoved();
                s.commitA = commitment;
            } else {
                if (s.commitB != bytes32(0)) revert AlreadyMoved();
                s.commitB = commitment;
            }
            if (s.commitA != bytes32(0) && s.commitB != bytes32(0)) s.phase = PHASE_BET_OPEN;
        } else if (kind == MOVE_BET_OPEN) {
            if (s.phase != PHASE_BET_OPEN) revert WrongPhase();
            (uint8 by, uint8 bet, bytes32 salt) = abi.decode(payload, (uint8, uint8, bytes32));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (bet != BET_RAISE && bet != BET_HOLD) revert IllegalMove();
            bytes32 expected = by == SEAT_A ? s.commitA : s.commitB;
            if (expected != _betCommitHash(bet, salt)) revert CommitMismatch();
            if (by == SEAT_A) {
                if (s.betA != 0) revert AlreadyMoved();
                s.betA = bet;
            } else {
                if (s.betB != 0) revert AlreadyMoved();
                s.betB = bet;
            }
            // rules.ts moves the raiser's ante into the pot ON THIS OPEN (per-seat,
            // incrementally), regardless of whether the other seat has opened yet.
            if (bet == BET_RAISE) {
                s.pot += s.ante;
                if (by == SEAT_A) s.contributedA += s.ante;
                else s.contributedB += s.ante;
            }
            // Resolution only happens once both seats have opened; it changes phase/raiser
            // only — all ante bookkeeping was already done on the individual RAISE opens.
            if (s.betA != 0 && s.betB != 0) {
                if (s.betA == s.betB) {
                    s.phase = PHASE_SHOWDOWN;
                    s.raiser = 0;
                } else {
                    s.raiser = s.betA == BET_RAISE ? SEAT_A : SEAT_B;
                    s.phase = PHASE_CALL_OR_FOLD;
                }
            }
        } else if (kind == MOVE_CALL) {
            if (s.phase != PHASE_CALL_OR_FOLD) revert WrongPhase();
            (uint8 by) = abi.decode(payload, (uint8));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (by == s.raiser) revert IllegalMove(); // raiser cannot call own raise
            s.pot += s.ante;
            if (by == SEAT_A) s.contributedA += s.ante;
            else s.contributedB += s.ante;
            s.phase = PHASE_SHOWDOWN;
        } else if (kind == MOVE_FOLD) {
            if (s.phase != PHASE_CALL_OR_FOLD) revert WrongPhase();
            (uint8 by) = abi.decode(payload, (uint8));
            if (by != SEAT_A && by != SEAT_B) revert WrongSeat();
            if (by == s.raiser) revert IllegalMove();
            s.resultWinner = s.raiser;
            s.resultAmount = s.pot + s.warPot;
            s.resultSet = true;
            s.foldedCardHidden = true;
            s.pot = 0;
            s.warPot = 0;
            s.phase = PHASE_FLIP_DONE;
        } else if (kind == MOVE_SHOWDOWN) {
            if (s.phase != PHASE_SHOWDOWN) revert WrongPhase();
            (uint8 cardA, uint8 cardB) = abi.decode(payload, (uint8, uint8));
            if (cardA > MAX_CARD || cardB > MAX_CARD || cardA == cardB) revert BadCard();
            uint8 rankA = cardA / CARDS_PER_RANK; // +2 offset irrelevant for comparison
            uint8 rankB = cardB / CARDS_PER_RANK;
            if (rankA == rankB) {
                s.warPot += s.pot;
                s.pot = 0;
                s.resultSet = false;
                s.resultWinner = 0;
                s.resultAmount = 0;
            } else {
                s.resultWinner = rankA > rankB ? SEAT_A : SEAT_B;
                s.resultAmount = s.pot + s.warPot;
                s.resultSet = true;
                s.pot = 0;
                s.warPot = 0;
            }
            s.phase = PHASE_FLIP_DONE;
        } else {
            revert IllegalMove();
        }
        return abi.encode(s);
    }

    /// Mirrors hilo-war hashBetCommit: keccak256(utf8 prefix ++ salt).
    function _betCommitHash(uint8 bet, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(
            bet == BET_RAISE ? bytes("hilo-war/bet/RAISE/") : bytes("hilo-war/bet/HOLD/"),
            salt
        ));
    }
}
