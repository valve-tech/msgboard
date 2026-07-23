// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SudokuRules} from "../zk/SudokuRules.sol";
import {SudokuLog} from "../games/SudokuLog.sol";

/// EAS schema resolver for the ZK-Sudoku leaderboard — the SKILL_GAMES_DESIGN.md "leaderboard =
/// EAS attestation" plan: a canonical leaderboard entry is an EAS attestation that can only exist
/// if the solve proof checks out, because this resolver re-runs exactly the checks
/// SudokuLog.logSolve performs (published-puzzle hash, fresh nullifier, PLONK verify) before
/// letting the attestation through. EAS-native indexing then serves the leaderboard without a
/// custom indexer; SudokuLog remains live as the pre-EAS record and neither path depends on the
/// other (separate nullifier books on purpose — each canonical record spends a solve once).
///
/// SCHEMA (field order is load-bearing — it IS the attestation encoding; register with
/// revocable=false):
///   uint256 puzzleId,uint256 player,uint256 nullifier,uint256[24] proof,uint256[81] puzzle
///
/// There is deliberately NO elapsed field: EAS stamps `attestation.time` natively, so readers
/// derive elapsed = time - openedAt. An attester-supplied elapsed would either be trusted (wrong)
/// or force the attester to predict the exact mined block timestamp (unusable).
///
/// The proof is bound to `player` via the nullifier (see SudokuRules), so a mempool watcher
/// cannot re-bind someone's solve; the attestation's `recipient`/`attester` are informational —
/// the leaderboard identity is `player`, same as SudokuLog.
contract SudokuSolveResolver is SchemaResolver {
    SudokuRules public immutable sudokuRules;
    SudokuLog public immutable sudokuLog;

    /// This resolver's own spent book: one attestation per solve nullifier. Separate from
    /// SudokuLog's so logging there does not block attesting here (and vice versa) — each
    /// CANONICAL record admits a solve exactly once.
    mapping(uint256 nullifier => bool) public attestedNullifier;

    error NotOpened(); // attesting a solve for a puzzle that was never published
    error BadPuzzle(); // the supplied board does not match the published puzzleHash
    error NullifierSpent(); // this solve was already attested (replay/double-entry)
    error BadProof(); // the PLONK solve proof did not verify for (puzzle, player, nullifier)
    error NotRevocable(); // solve attestations are permanent — register the schema revocable=false

    constructor(IEAS eas, SudokuLog sudokuLog_) SchemaResolver(eas) {
        sudokuLog = sudokuLog_;
        sudokuRules = sudokuLog_.sudokuRules();
    }

    function onAttest(Attestation calldata attestation, uint256 /* value */ ) internal override returns (bool) {
        (uint256 puzzleId, uint256 player, uint256 nullifier, uint256[24] memory proof, uint256[81] memory puzzle) =
            abi.decode(attestation.data, (uint256, uint256, uint256, uint256[24], uint256[81]));

        (bytes32 puzzleHash, uint256 openedAt) = sudokuLog.puzzles(puzzleId);
        if (openedAt == 0) revert NotOpened();
        if (keccak256(abi.encode(puzzle)) != puzzleHash) revert BadPuzzle();
        if (attestedNullifier[nullifier]) revert NullifierSpent();
        if (!sudokuRules.checkSolve(proof, puzzle, player, nullifier)) revert BadProof();

        attestedNullifier[nullifier] = true;
        return true;
    }

    /// A proven solve happened; it cannot un-happen. The schema is registered revocable=false,
    /// so EAS blocks revocation before ever reaching here — this is defense in depth.
    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        revert NotRevocable();
    }
}
