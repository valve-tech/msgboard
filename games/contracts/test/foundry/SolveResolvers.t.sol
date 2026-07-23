// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData,
    Attestation
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SudokuSolveResolver} from "../../contracts/eas/SudokuSolveResolver.sol";
import {WordleSolveResolver} from "../../contracts/eas/WordleSolveResolver.sol";
import {SudokuLog} from "../../contracts/games/SudokuLog.sol";
import {SudokuRules} from "../../contracts/zk/SudokuRules.sol";
import {SudokuSolvePlonkVerifier} from "../../contracts/zk/generated/SudokuSolvePlonkVerifier.sol";
import {WordleLog} from "../../contracts/games/WordleLog.sol";
import {WordleRules} from "../../contracts/zk/WordleRules.sol";
import {WordleCluePlonkVerifier} from "../../contracts/zk/generated/WordleCluePlonkVerifier.sol";
import {WordleSolvePlonkVerifier} from "../../contracts/zk/generated/WordleSolvePlonkVerifier.sol";

/// The EAS leaderboard path (SKILL_GAMES_DESIGN.md "leaderboard = EAS attestation"): a REAL EAS +
/// SchemaRegistry deployment, the two proof-gated solve resolvers registered as schema resolvers
/// (revocable=false), and REAL PLONK proofs from the pinned fixtures driven through EAS.attest —
/// proving an attestation can only exist when the solve proof verifies, exactly once per solve,
/// and can never be revoked. Runs under the dedicated `eas` foundry profile (EAS pins solc 0.8.27).
contract SolveResolversTest is Test {
    SchemaRegistry internal registry;
    EAS internal eas;

    SudokuRules internal sudokuRules;
    SudokuLog internal sudokuLog;
    SudokuSolveResolver internal sudokuResolver;
    bytes32 internal sudokuSchemaUid;

    WordleRules internal wordleRules;
    WordleLog internal wordleLog;
    WordleSolveResolver internal wordleResolver;
    bytes32 internal wordleSchemaUid;

    // sudoku fixture
    uint256[24] internal sProof;
    uint256[81] internal puzzle;
    uint256 internal nullifier;
    uint256 internal player;
    uint256 internal constant PUZZLE_ID = 42;

    // wordle fixture
    uint256[24] internal wProof;
    uint256 internal wCommit;
    uint256 internal guessesCommit;
    uint256 internal dictRoot;
    uint256 internal guessesUsed;
    uint256 internal constant CHALLENGE_ID = 7;

    string internal constant SUDOKU_SCHEMA =
        "uint256 puzzleId,uint256 player,uint256 nullifier,uint256[24] proof,uint256[81] puzzle";
    string internal constant WORDLE_SCHEMA =
        "uint256 challengeId,uint256 guessesUsed,uint256 guessesCommit,uint256[24] proof";

    function setUp() public {
        registry = new SchemaRegistry();
        eas = new EAS(registry);

        // sudoku stack + resolver + schema
        sudokuRules = new SudokuRules(address(new SudokuSolvePlonkVerifier()));
        sudokuLog = new SudokuLog(address(sudokuRules));
        sudokuResolver = new SudokuSolveResolver(IEAS(address(eas)), sudokuLog);
        sudokuSchemaUid = registry.register(SUDOKU_SCHEMA, ISchemaResolver(address(sudokuResolver)), false);

        string memory sj = vm.readFile("test/foundry/fixtures/sudokuSolveProof.json");
        uint256[] memory spf = vm.parseJsonUintArray(sj, ".proof");
        uint256[] memory sps = vm.parseJsonUintArray(sj, ".pubSignals");
        for (uint256 i = 0; i < 24; i++) sProof[i] = spf[i];
        nullifier = sps[0];
        player = sps[3];
        uint256[] memory cells = vm.parseJsonUintArray(sj, ".vector.puzzle");
        for (uint256 i = 0; i < 81; i++) puzzle[i] = cells[i];

        // wordle stack + resolver + schema
        wordleRules = new WordleRules(address(new WordleCluePlonkVerifier()), address(new WordleSolvePlonkVerifier()));
        string memory wj = vm.readFile("test/foundry/fixtures/wordleSolveProof.json");
        uint256[] memory wpf = vm.parseJsonUintArray(wj, ".proof");
        uint256[] memory wps = vm.parseJsonUintArray(wj, ".pubSignals");
        for (uint256 i = 0; i < 24; i++) wProof[i] = wpf[i];
        wCommit = wps[0];
        guessesCommit = wps[1];
        dictRoot = wps[2];
        guessesUsed = wps[3];
        wordleLog = new WordleLog(address(wordleRules), dictRoot);
        wordleResolver = new WordleSolveResolver(IEAS(address(eas)), wordleLog);
        wordleSchemaUid = registry.register(WORDLE_SCHEMA, ISchemaResolver(address(wordleResolver)), false);
    }

    // ---- helpers ----------------------------------------------------------------------------------

    function _sudokuRequest(uint256[24] memory proof, uint256[81] memory board)
        internal
        view
        returns (AttestationRequest memory)
    {
        return AttestationRequest({
            schema: sudokuSchemaUid,
            data: AttestationRequestData({
                recipient: address(this),
                expirationTime: 0,
                revocable: false,
                refUID: bytes32(0),
                data: abi.encode(PUZZLE_ID, player, nullifier, proof, board),
                value: 0
            })
        });
    }

    function _wordleRequest(address recipient, uint256 used) internal view returns (AttestationRequest memory) {
        return AttestationRequest({
            schema: wordleSchemaUid,
            data: AttestationRequestData({
                recipient: recipient,
                expirationTime: 0,
                revocable: false,
                refUID: bytes32(0),
                data: abi.encode(CHALLENGE_ID, used, guessesCommit, wProof),
                value: 0
            })
        });
    }

    // ---- sudoku -----------------------------------------------------------------------------------

    function test_sudoku_attest_gatedByRealProof() public {
        vm.warp(1_000_000);
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        vm.warp(1_000_000 + 137);

        bytes32 uid = eas.attest(_sudokuRequest(sProof, puzzle));

        assertTrue(sudokuResolver.attestedNullifier(nullifier), "nullifier recorded in the resolver book");
        Attestation memory a = eas.getAttestation(uid);
        assertEq(a.schema, sudokuSchemaUid, "schema bound");
        (, uint256 openedAt) = sudokuLog.puzzles(PUZZLE_ID);
        // The leaderboard's elapsed is DERIVED (EAS-native time - openedAt), never attester-supplied.
        assertEq(uint256(a.time) - openedAt, 137, "elapsed derives from attestation.time");
    }

    function test_sudoku_secondAttest_reverts_nullifierSpent() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        eas.attest(_sudokuRequest(sProof, puzzle));
        vm.expectRevert(SudokuSolveResolver.NullifierSpent.selector);
        eas.attest(_sudokuRequest(sProof, puzzle));
    }

    function test_sudoku_attest_beforeOpen_reverts() public {
        vm.expectRevert(SudokuSolveResolver.NotOpened.selector);
        eas.attest(_sudokuRequest(sProof, puzzle));
    }

    function test_sudoku_wrongBoard_reverts_badPuzzle() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        uint256[81] memory tampered = puzzle;
        tampered[0] = tampered[0] == 9 ? 1 : tampered[0] + 1;
        vm.expectRevert(SudokuSolveResolver.BadPuzzle.selector);
        eas.attest(_sudokuRequest(sProof, tampered));
    }

    function test_sudoku_tamperedProof_reverts_badProof() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        uint256[24] memory tampered = sProof;
        tampered[0] ^= 1;
        vm.expectRevert(SudokuSolveResolver.BadProof.selector);
        eas.attest(_sudokuRequest(tampered, puzzle));
    }

    function test_sudoku_logAndAttest_areIndependentBooks() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        sudokuLog.logSolve(PUZZLE_ID, sProof, puzzle, player, nullifier);
        // Logging on SudokuLog spends ITS nullifier book, not the resolver's — the EAS entry still works.
        bytes32 uid = eas.attest(_sudokuRequest(sProof, puzzle));
        assertTrue(uid != bytes32(0), "attested after logSolve");
    }

    function test_sudoku_revocation_isBlockedByEas() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        bytes32 uid = eas.attest(_sudokuRequest(sProof, puzzle));
        // Schema registered revocable=false: EAS itself refuses (the resolver's onRevoke is depth-2).
        vm.expectRevert();
        eas.revoke(RevocationRequest({schema: sudokuSchemaUid, data: RevocationRequestData({uid: uid, value: 0})}));
    }

    // ---- wordle -----------------------------------------------------------------------------------

    function test_wordle_attest_gatedByRealProof() public {
        wordleLog.openChallenge(CHALLENGE_ID, wCommit);
        bytes32 uid = eas.attest(_wordleRequest(address(this), guessesUsed));
        assertTrue(wordleResolver.attested(CHALLENGE_ID, guessesCommit), "guess sequence recorded");
        Attestation memory a = eas.getAttestation(uid);
        assertEq(a.recipient, address(this), "solver is the recipient");
    }

    function test_wordle_recipientMustBeAttester() public {
        wordleLog.openChallenge(CHALLENGE_ID, wCommit);
        vm.expectRevert(WordleSolveResolver.NotSelf.selector);
        eas.attest(_wordleRequest(address(0xBEEF), guessesUsed));
    }

    function test_wordle_secondAttest_reverts() public {
        wordleLog.openChallenge(CHALLENGE_ID, wCommit);
        eas.attest(_wordleRequest(address(this), guessesUsed));
        vm.expectRevert(WordleSolveResolver.AlreadyAttested.selector);
        eas.attest(_wordleRequest(address(this), guessesUsed));
    }

    function test_wordle_wrongGuessesUsed_reverts_badProof() public {
        wordleLog.openChallenge(CHALLENGE_ID, wCommit);
        // The proof binds guessesUsed in-circuit — claiming a better score fails verification.
        vm.expectRevert(WordleSolveResolver.BadProof.selector);
        eas.attest(_wordleRequest(address(this), guessesUsed == 1 ? 2 : guessesUsed - 1));
    }

    function test_wordle_unopenedChallenge_reverts() public {
        vm.expectRevert(WordleSolveResolver.NotOpened.selector);
        eas.attest(_wordleRequest(address(this), guessesUsed));
    }
}
