// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Ownable} from "solady/src/auth/Ownable.sol";
import {SudokuRules} from "../zk/SudokuRules.sol";

/// Timed, Chips-FREE leaderboard for the ZK-Sudoku speedrun. This is deliberately NOT a wagered game
/// (that is what SkillSettle/HouseChannel are for): Sudoku is a speedrun with a cryptographic finish
/// line, not a casino bet. A flat-multiplier bet on a public, trivially-automatable solve is strictly
/// -EV for the house and the proof cannot tell a fast human from a bot — so there is nothing to escrow
/// and no payout. Instead we log, fully on-chain and trustlessly, WHO solved a published puzzle and HOW
/// LONG it took (block.timestamp at solve − block.timestamp at open). That elapsed time is the
/// leaderboard; no funds are ever held here.
///
/// It reuses the EXISTING SudokuRules verifier wrapper as-is: a solve proof proves the relayer knows a
/// valid solution to the committed public `puzzle`, bound to a public `player` via a `nullifier`, WITHOUT
/// revealing the solution. Two properties carry over from the wagered design and are what make the
/// leaderboard honest:
///   • the proof verifies only for the exact (puzzle, player, nullifier) triple it was made for, so a
///     mempool watcher cannot copy someone's solve and re-bind it to their own address (anti-front-run);
///   • the nullifier is recorded spent, so a solve can be logged at most once (no replay / double-log).
///
/// nullifier = Poseidon(rowDigest[0..8], player) — see SudokuRules / circuits/sudoku_solve.circom.
contract SudokuLog is Ownable {
    /// The reused PLONK verifier wrapper (contracts/zk/SudokuRules.sol) — UNCHANGED.
    SudokuRules public immutable sudokuRules;

    struct Puzzle {
        bytes32 puzzleHash; // keccak256(abi.encode(puzzle[81])) — pins the exact published board
        uint256 openedAt;   // block.timestamp when the house published it; 0 == not opened
    }

    /// Published puzzles by id. openedAt == 0 means "never opened".
    mapping(uint256 puzzleId => Puzzle) public puzzles;
    /// Anti-replay / anti-front-run: a solve proof's player-bound nullifier can be logged at most once.
    mapping(uint256 nullifier => bool) public spentNullifier;

    error AlreadyOpened();       // puzzleId already published
    error NotOpened();           // logSolve before the puzzle was opened
    error BadPuzzle();           // the supplied puzzle does not match the published puzzleHash
    error NullifierSpent();      // this solve proof's nullifier was already logged (replay/double-log)
    error BadProof();            // the PLONK solve proof did not verify for (puzzle, player, nullifier)

    event PuzzleOpened(uint256 indexed puzzleId, uint256 openedAt);
    /// A trustless leaderboard entry: `player` solved `puzzleId` at `solvedAt`, taking `elapsed` seconds.
    event Solved(
        uint256 indexed puzzleId,
        uint256 indexed player,
        uint256 nullifier,
        uint256 solvedAt,
        uint256 elapsed
    );

    constructor(address sudokuRules_) {
        sudokuRules = SudokuRules(sudokuRules_);
        _initializeOwner(msg.sender);
    }

    /// The house publishes a puzzle to start its clock. Stores keccak256(abi.encode(puzzle)) so any
    /// later solve must be against THIS exact board, and stamps `openedAt` as the leaderboard's start.
    /// onlyOwner: the house controls which puzzles are official (and when their clock starts).
    function openPuzzle(uint256 puzzleId, uint256[81] calldata puzzle) external onlyOwner {
        Puzzle storage p = puzzles[puzzleId];
        if (p.openedAt != 0) revert AlreadyOpened();
        p.puzzleHash = keccak256(abi.encode(puzzle));
        p.openedAt = block.timestamp;
        emit PuzzleOpened(puzzleId, block.timestamp);
    }

    /// Permissionless relay of a solve. Verifies the solve proof against the published puzzle, records
    /// the nullifier spent, and emits the on-chain leaderboard entry with the elapsed solve time. Anyone
    /// may relay (the proof is bound to `player`, so relaying gains a front-runner nothing) — the entry
    /// always credits `player`.
    function logSolve(
        uint256 puzzleId,
        uint256[24] calldata proof,
        uint256[81] calldata puzzle,
        uint256 player,
        uint256 nullifier
    ) external {
        Puzzle storage p = puzzles[puzzleId];
        if (p.openedAt == 0) revert NotOpened();
        if (keccak256(abi.encode(puzzle)) != p.puzzleHash) revert BadPuzzle();
        if (spentNullifier[nullifier]) revert NullifierSpent();
        // The proof is bound to `player` via the nullifier: a watcher cannot re-bind someone's solve.
        if (!sudokuRules.checkSolve(proof, puzzle, player, nullifier)) revert BadProof();

        spentNullifier[nullifier] = true;
        emit Solved(puzzleId, player, nullifier, block.timestamp, block.timestamp - p.openedAt);
    }
}
