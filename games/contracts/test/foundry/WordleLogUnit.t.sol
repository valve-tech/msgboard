// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WordleLog} from "../../contracts/games/WordleLog.sol";
import {WordleRules} from "../../contracts/zk/WordleRules.sol";
import {WordleCluePlonkVerifier} from "../../contracts/zk/generated/WordleCluePlonkVerifier.sol";
import {WordleSolvePlonkVerifier} from "../../contracts/zk/generated/WordleSolvePlonkVerifier.sol";

/// COVERAGE ONLY: no changes to contracts/games/WordleLog.sol. This is WordleLog's default-profile
/// unit suite — until now its only coverage came from the `eas` profile's SolveResolvers suite
/// (an EAS-attestation integration test), which never exercised WordleLog in isolation under the
/// default (viaIR, solc 0.8.25) profile.
///
/// Structural twin of SudokuLog.t.sol: deploys the REAL WordleSolvePlonkVerifier + WordleRules
/// wrapper and feeds the same `wordleSolveProof.json` fixture WordleRules.t.sol uses (word/guess
/// sequence solved in 2 guesses; pubSignals = [commit, guessesCommit, dictRoot, guessesUsed]).
/// WordleLog's immutable `dictRoot` is constructed from the fixture's own dictRoot so the real
/// proof verifies end-to-end through `logSolve`.
contract WordleLogUnitTest is Test {
    WordleRules internal rules;
    WordleLog internal wordleLog;

    uint256[24] internal proof;
    uint256 internal fixtureCommit;
    uint256 internal fixtureGuessesCommit;
    uint256 internal fixtureDictRoot;
    uint256 internal fixtureGuessesUsed;

    uint256 internal constant CHALLENGE_ID = 7;

    // Re-declared here so vm.expectEmit can match on the event signature.
    event ChallengeOpened(uint256 indexed challengeId, address indexed setter, uint256 commit, uint256 openedAt);
    event Solved(
        uint256 indexed challengeId,
        address indexed solver,
        uint256 guessesUsed,
        uint256 guessesCommit,
        uint256 solvedAt
    );

    function setUp() public {
        rules = new WordleRules(address(new WordleCluePlonkVerifier()), address(new WordleSolvePlonkVerifier()));

        string memory json = vm.readFile("test/foundry/fixtures/wordleSolveProof.json");
        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        uint256[] memory ps = vm.parseJsonUintArray(json, ".pubSignals");
        assertEq(pf.length, 24, "wordle solve fixture must have 24 plonk proof fields");
        assertEq(ps.length, 4, "wordle solve fixture must have 4 public signals");
        for (uint256 i = 0; i < 24; i++) proof[i] = pf[i];
        fixtureCommit = ps[0];
        fixtureGuessesCommit = ps[1];
        fixtureDictRoot = ps[2];
        fixtureGuessesUsed = ps[3];

        // Construct WordleLog's immutable dictRoot from the fixture so the real proof verifies.
        wordleLog = new WordleLog(address(rules), fixtureDictRoot);
    }

    // ---- positive: full open -> log flow, event content, storage, anti-replay bookkeeping --------

    function test_openThenLogSolve_emitsSolvedAndRecordsLogged() public {
        vm.warp(1_000_000);
        address setter = address(0xA11CE);
        vm.expectEmit(true, true, false, true, address(wordleLog));
        emit ChallengeOpened(CHALLENGE_ID, setter, fixtureCommit, 1_000_000);
        vm.prank(setter);
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);

        (uint256 storedCommit, address storedSetter, uint256 openedAt) = wordleLog.challenges(CHALLENGE_ID);
        assertEq(storedCommit, fixtureCommit, "commit stored");
        assertEq(storedSetter, setter, "setter recorded");
        assertEq(openedAt, 1_000_000, "openedAt stamped");

        assertFalse(wordleLog.logged(CHALLENGE_ID, fixtureGuessesCommit), "not logged before solve");

        // ANYONE may relay the real proof (permissionless); the entry credits msg.sender as solver.
        vm.warp(1_000_000 + 42);
        address solver = address(0xBEEF);
        vm.expectEmit(true, true, false, true, address(wordleLog));
        emit Solved(CHALLENGE_ID, solver, fixtureGuessesUsed, fixtureGuessesCommit, 1_000_000 + 42);
        vm.prank(solver);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);

        assertTrue(wordleLog.logged(CHALLENGE_ID, fixtureGuessesCommit), "guess sequence recorded logged");
    }

    // A different challengeId is a distinct anti-replay bucket: the same guessesCommit that was
    // logged against CHALLENGE_ID has NOT been logged against another id (mapping keyed on
    // (challengeId, guessesCommit) — the nullifier-book is per-challenge, not global).
    function test_logged_bookkeeping_isPerChallenge() public {
        uint256 otherId = CHALLENGE_ID + 1;
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        wordleLog.openChallenge(otherId, fixtureCommit);

        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);

        assertTrue(wordleLog.logged(CHALLENGE_ID, fixtureGuessesCommit), "logged on the solved challenge");
        assertFalse(wordleLog.logged(otherId, fixtureGuessesCommit), "NOT logged on the other challenge");
    }

    // ---- openChallenge: AlreadyOpened --------------------------------------------------------------

    function test_openChallenge_twice_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        vm.expectRevert(WordleLog.AlreadyOpened.selector);
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
    }

    // openChallenge is deliberately permissionless (per the contract's NatSpec) — confirm a
    // stranger CAN open a fresh challenge (the false branch of `c.openedAt != 0`, exercised by
    // someone other than the eventual solver/relayer).
    function test_openChallenge_permissionless_strangerCanOpen() public {
        vm.prank(address(0xCAFE));
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        (, address storedSetter,) = wordleLog.challenges(CHALLENGE_ID);
        assertEq(storedSetter, address(0xCAFE), "stranger recorded as setter");
    }

    // ---- logSolve: NotOpened ------------------------------------------------------------------------

    function test_logSolve_beforeOpen_reverts() public {
        vm.expectRevert(WordleLog.NotOpened.selector);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);
    }

    // ---- logSolve: WrongDictRoot ---------------------------------------------------------------------

    function test_logSolve_wrongDictRoot_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        vm.expectRevert(WordleLog.WrongDictRoot.selector);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot + 1, fixtureGuessesUsed);
    }

    // ---- logSolve: AlreadyLogged (the nullifier-book / anti-replay branch) --------------------------

    function test_logSolve_replaySameGuessesCommit_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);
        vm.expectRevert(WordleLog.AlreadyLogged.selector);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);
    }

    // AlreadyLogged is checked BEFORE the proof is verified — even a tampered/garbage proof on an
    // already-logged sequence must revert AlreadyLogged, not BadProof (checkSolve is never reached).
    function test_logSolve_replayWithTamperedProof_stillAlreadyLogged() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);

        uint256[24] memory badProof = proof;
        badProof[0] = proof[0] ^ 0xff;
        vm.expectRevert(WordleLog.AlreadyLogged.selector);
        wordleLog.logSolve(CHALLENGE_ID, badProof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);
    }

    // ---- logSolve: BadProof (the proof-gating branch), several distinct failure shapes -------------

    function test_logSolve_tamperedProofBytes_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        uint256[24] memory badProof = proof;
        badProof[0] = proof[0] ^ 0xff;
        vm.expectRevert(WordleLog.BadProof.selector);
        wordleLog.logSolve(CHALLENGE_ID, badProof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);
    }

    // The proof is bound to the setter's REAL word commitment (c.commit). Opening the challenge
    // with a different commit means checkSolve(proof, c.commit, ...) is verifying against the
    // wrong word-commitment public input -> PLONK verify fails closed.
    function test_logSolve_wrongChallengeCommitBinding_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit + 1);
        vm.expectRevert(WordleLog.BadProof.selector);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed);
    }

    // Understating guessesUsed (claiming a better leaderboard rank than proven) is a mismatched
    // public input -> fails the same PLONK verify, gated the same way as a tampered proof.
    function test_logSolve_wrongGuessesUsed_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        vm.expectRevert(WordleLog.BadProof.selector);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit, fixtureDictRoot, fixtureGuessesUsed - 1);
    }

    // A guessesCommit not matching what the proof was generated for is also a mismatched public
    // input in the PLONK verify.
    function test_logSolve_wrongGuessesCommit_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, fixtureCommit);
        vm.expectRevert(WordleLog.BadProof.selector);
        wordleLog.logSolve(CHALLENGE_ID, proof, fixtureGuessesCommit + 1, fixtureDictRoot, fixtureGuessesUsed);
    }
}
