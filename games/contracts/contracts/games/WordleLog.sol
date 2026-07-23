// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {WordleRules} from "../zk/WordleRules.sol";

/// Non-wagered ZK-Wordle for playing with friends — a proof-verified record, NOT a house/casino game
/// (that is what the retired SkillSettle was). There is no Chips, no escrow, no house, and no payout.
/// A setter commits a hidden word and opens a challenge; friends who solve it submit a wordle_solve
/// proof and are logged on a per-challenge leaderboard ranked by GUESSES USED (fewer = better).
///
/// It reuses the EXISTING WordleRules verifier as-is: a wordle_solve proof proves the committed ordered
/// guess sequence's first all-green position (guessesUsed, FORCED in-circuit) against the setter's
/// committed word (`commit`) with the answer in the committed dictionary (`dictRoot`) — without
/// revealing the word or the guesses. `commit = Poseidon(word, salt)`.
///
/// Solver identity is bound at submission (msg.sender): the wordle_solve circuit does not carry a
/// player signal, so a mempool watcher could in principle relay someone else's solve proof under their
/// own address. For a friendly (non-wagered) game this is acceptable; binding the solver in-circuit
/// would be a future circuit change. Each distinct guess sequence (`guessesCommit`) can be logged at
/// most once per challenge (anti-replay).
contract WordleLog {
    /// The reused PLONK Wordle verifier wrapper (contracts/zk/WordleRules.sol) — UNCHANGED.
    WordleRules public immutable wordleRules;
    /// The committed dictionary root every solve proof must be against (the real word list).
    uint256 public immutable dictRoot;

    struct Challenge {
        uint256 commit;  // Poseidon(word, salt) — the setter's hidden-word commitment
        address setter;  // who opened the challenge
        uint256 openedAt; // block.timestamp at open; 0 == not opened
    }

    /// Challenges by id. openedAt == 0 means "never opened".
    mapping(uint256 challengeId => Challenge) public challenges;
    /// Anti-replay: a given guess sequence can be logged at most once per challenge.
    mapping(uint256 challengeId => mapping(uint256 guessesCommit => bool)) public logged;

    error AlreadyOpened();   // challengeId already opened
    error NotOpened();       // logSolve before the challenge was opened
    error WrongDictRoot();   // the proof's dictRoot is not the committed one
    error AlreadyLogged();   // this guess sequence was already logged for this challenge
    error BadProof();        // the wordle_solve proof did not verify for (commit, guessesCommit, dictRoot, guessesUsed)

    event ChallengeOpened(uint256 indexed challengeId, address indexed setter, uint256 commit, uint256 openedAt);
    /// A trustless leaderboard entry: `solver` solved `challengeId` in `guessesUsed` guesses at `solvedAt`.
    event Solved(
        uint256 indexed challengeId,
        address indexed solver,
        uint256 guessesUsed,
        uint256 guessesCommit,
        uint256 solvedAt
    );

    constructor(address wordleRules_, uint256 dictRoot_) {
        wordleRules = WordleRules(wordleRules_);
        dictRoot = dictRoot_;
    }

    /// Open a challenge with a hidden-word commitment. Permissionless — anyone can set a word for
    /// friends to solve. Stamps `openedAt` and records the setter.
    function openChallenge(uint256 challengeId, uint256 commit) external {
        Challenge storage c = challenges[challengeId];
        if (c.openedAt != 0) revert AlreadyOpened();
        c.commit = commit;
        c.setter = msg.sender;
        c.openedAt = block.timestamp;
        emit ChallengeOpened(challengeId, msg.sender, commit, block.timestamp);
    }

    /// Log a solve. Verifies the wordle_solve proof against the challenge's committed word + the
    /// committed dictionary, records the guess sequence spent, and emits the leaderboard entry crediting
    /// msg.sender with `guessesUsed`.
    function logSolve(
        uint256 challengeId,
        uint256[24] calldata proof,
        uint256 guessesCommit,
        uint256 proofDictRoot,
        uint256 guessesUsed
    ) external {
        Challenge storage c = challenges[challengeId];
        if (c.openedAt == 0) revert NotOpened();
        if (proofDictRoot != dictRoot) revert WrongDictRoot();
        if (logged[challengeId][guessesCommit]) revert AlreadyLogged();
        if (!wordleRules.checkSolve(proof, c.commit, guessesCommit, proofDictRoot, guessesUsed)) revert BadProof();

        logged[challengeId][guessesCommit] = true;
        emit Solved(challengeId, msg.sender, guessesUsed, guessesCommit, block.timestamp);
    }
}
