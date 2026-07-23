// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {WordleRules} from "../zk/WordleRules.sol";
import {WordleLog} from "../games/WordleLog.sol";

/// EAS schema resolver for the ZK-Wordle "play with friends" record — the attestation twin of
/// WordleLog.logSolve: an attestation exists only if the wordle_solve proof verifies against the
/// challenge's committed word and the committed dictionary. See SudokuSolveResolver for the
/// design rationale (proof-gated attestations, EAS-native indexing, parallel to the Log path).
///
/// SCHEMA (field order is load-bearing — it IS the attestation encoding; register with
/// revocable=false):
///   uint256 challengeId,uint256 guessesUsed,uint256 guessesCommit,uint256[24] proof
///
/// SOLVER IDENTITY: the wordle_solve circuit carries no player signal (WordleLog binds
/// msg.sender), so here the solver is the attestation's `recipient`, and it must equal the
/// `attester` — the same "whoever submits it, claims it" trust level as WordleLog, made explicit.
/// Solve time is EAS-native `attestation.time`; guesses-used is the ranked score.
contract WordleSolveResolver is SchemaResolver {
    WordleRules public immutable wordleRules;
    WordleLog public immutable wordleLog;

    /// One attestation per (challenge, guess sequence) — the same anti-replay key WordleLog uses,
    /// in this resolver's own book so the two canonical records stay independent.
    mapping(uint256 challengeId => mapping(uint256 guessesCommit => bool)) public attested;

    error NotOpened(); // attesting a solve for a challenge that was never opened
    error AlreadyAttested(); // this guess sequence was already attested for this challenge
    error NotSelf(); // recipient != attester — a solve credits whoever submits it, explicitly
    error BadProof(); // the wordle_solve proof did not verify
    error NotRevocable(); // solve attestations are permanent — register the schema revocable=false

    constructor(IEAS eas, WordleLog wordleLog_) SchemaResolver(eas) {
        wordleLog = wordleLog_;
        wordleRules = wordleLog_.wordleRules();
    }

    function onAttest(Attestation calldata attestation, uint256 /* value */ ) internal override returns (bool) {
        (uint256 challengeId, uint256 guessesUsed, uint256 guessesCommit, uint256[24] memory proof) =
            abi.decode(attestation.data, (uint256, uint256, uint256, uint256[24]));

        (uint256 commit,, uint256 openedAt) = wordleLog.challenges(challengeId);
        if (openedAt == 0) revert NotOpened();
        if (attested[challengeId][guessesCommit]) revert AlreadyAttested();
        if (attestation.recipient != attestation.attester) revert NotSelf();
        if (!wordleRules.checkSolve(proof, commit, guessesCommit, wordleLog.dictRoot(), guessesUsed)) {
            revert BadProof();
        }

        attested[challengeId][guessesCommit] = true;
        return true;
    }

    /// A proven solve happened; it cannot un-happen (schema registered revocable=false; this is
    /// defense in depth).
    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        revert NotRevocable();
    }
}
