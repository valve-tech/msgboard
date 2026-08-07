// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// NOTE ON PROOF PROVENANCE (GPL): the fixture this test consumes is generated live (via vm.ffi)
// by games/zk-core/scripts/gen-showdown-dispute.mts, which uses the GPLv3-derived
// @zypher-game/secret-engine WASM prover — PoC only, pending license review (same posture as
// HoldemShareDispute.t.sol / RevealVerifierBabyJubJub.t.sol). The vendored on-chain
// RevealVerifier/ZkTable are unchanged; only off-chain proof GENERATION is GPL-derived.

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";
import {HiLoWarRules} from "../../contracts/zk/HiLoWarRules.sol";
import {HiLo, HiLoCodec} from "./HiLoWarRules.t.sol";
// Referenced only by name (via deployCodeTo, to sidestep EIP-170 — see setUp()), but the import
// is what makes forge compile RevealVerifier.sol at all: nothing else in this profile's
// compilation graph pulls it in (HiLoWarRules only takes its address, never the type), so without
// this import `vm.getCode`/deployCodeTo would find no artifact to etch.
import {RevealVerifier as _RevealVerifierArtifact} from "../../contracts/vendor/uzkge/shuffle/RevealVerifier.sol";

/// @notice Real-money HEADLINE tests: closes BOTH the "forced-reveal-then-refuse-to-cosign"
/// deadlock AND the disputant free-roll, end-to-end with REAL cryptography throughout — a real
/// Baby-JubJub masked deck, real Groth16 `verifyRevealWithSnark`-compatible reveal proofs (via
/// the zypher-game secret-engine package's `reveal_card_with_snark`, generated fresh by
/// `vm.ffi` — no stubs, no static fixture), the real vendored RevealVerifier (etched at full
/// size, bypassing EIP-170 the same way the hardhat ZkTableDispute.test.ts suite does), and real
/// HiLoWarRules rank logic. Proves:
///   1. both seats posting their two reveals via postShowdownReveals leaves the table Disputed
///      (not Live) — the deadlock is gone;
///   2. finalizeShowdown then pays the rank-correct winner, conserving the full escrow;
///   3. resolveTimeout is answer-aware: if only the COUNTERPARTY reveals and the disputant posts
///      nothing (the free-roll attempt), timeout pays the counterparty, not the silent
///      disputant — with real crypto end to end, not just a MockGameRules trace;
///   4. once both sides revealed (haveMask == 0x0F), resolveTimeout refuses (MustFinalize);
///   5. a tampered proof / wrong-seat's-key proof still reverts BadProof against the REAL
///      verifier (not a mock) — the safety side of the fix.
///
/// Requires --ffi (run via the `ffi` profile:
///   FOUNDRY_PROFILE=ffi forge test --match-path 'test/foundry/ZkTableShowdownDispute.t.sol' --ffi
/// ).
///
/// UNREACHABLE WITHOUT THE FIX: pre-fix, `ChannelTableBase` had no DEMAND_SHOWDOWN constant and
/// `openDispute`'s demand-kind guard accepted only DEMAND_MOVE/DEMAND_SHARE — `zk.openDispute(...,
/// demandKind: 3, ...)` reverted `BadDemand` outright, and the only real lever (a DEMAND_SHARE
/// dispute) cleared straight back to Live on the counterparty's first matching answer
/// (respondWithShare's `_clearDispute`) with no payout path from a revealed card at all. And the
/// FIRST (still-vulnerable) version of this showdown machinery — before THIS round's fix — used a
/// demand-kind-agnostic `resolveTimeout` that paid `t.disputant` unconditionally for any showdown
/// timeout, regardless of who had actually revealed: `test_resolveTimeout_cpAnsweredOnly_...`
/// below asserts the pot goes to B (the counterparty who revealed) while A (the disputant, who
/// revealed nothing) gets only its balance — that assertion is the exact opposite of what the
/// vulnerable version paid, so it is a genuine regression test for the free-roll, not just new
/// coverage.
contract ZkTableShowdownDisputeTest is Test {
    ZkTable internal zk;
    MockX402 internal token;
    HiLoWarRules internal rules;
    address internal revealVerifier;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    address internal a;
    address internal b;

    uint64 internal constant CLOCK = 30;
    uint256 internal constant ESCROW = 2 ether;
    uint8 internal constant DEMAND_SHOWDOWN = 3;

    // deckIndex 3 -> slotA=3 (rank0), slotB=4 (rank1) -> seat B wins on rank.
    uint32 internal constant DECK_INDEX = 3;
    uint32 internal constant SLOT_A = 3;
    uint32 internal constant SLOT_B = 4;

    struct Fixture {
        uint256[2] deckKeyA;
        uint256[2] deckKeyB;
        uint256[] deck;
        bytes32 deckCommitment;
        uint256[] revealsFlat; // 8 words: 4 x [x,y], ordered [A@slotA, B@slotA, A@slotB, B@slotB]
        uint256[] proofsFlat;  // 32 words: 4 x [8]
    }

    /// Slices reveal `i` (0..3, order A-slotA/B-slotA/A-slotB/B-slotB) out of the flattened blob.
    function _reveal(Fixture memory f, uint256 i) internal pure returns (uint256[2] memory r) {
        r[0] = f.revealsFlat[2 * i];
        r[1] = f.revealsFlat[2 * i + 1];
    }

    /// Slices proof `i` (same ordering) out of the flattened blob.
    function _proof(Fixture memory f, uint256 i) internal pure returns (uint256[8] memory p) {
        for (uint256 j = 0; j < 8; j++) p[j] = f.proofsFlat[8 * i + j];
    }

    function setUp() public {
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        token = new MockX402();
        token.mint(a, 1_000 ether);
        token.mint(b, 1_000 ether);

        // RevealVerifier's runtime (~30KB) exceeds EIP-170; etch it via forge-std's deployCodeTo
        // (runs the real constructor through a raw call, then etches the resulting runtime code —
        // sidesteps the CREATE-time size check the same way hardhat_setCode does in the mirror
        // hardhat suite, ZkTableDispute.test.ts's deployOrEtchRevealVerifier).
        revealVerifier = _deployReveal();
        rules = new HiLoWarRules(revealVerifier, address(0));
        zk = new ZkTable(address(0)); // factory=0 skips the clone-check (unit-test funding via a bare mock)
    }

    // ── x402 deposit-auth helpers ────────────────────────────────────────────

    uint64 internal constant VALID_BEFORE = type(uint64).max;

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (ZkTable.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return ZkTable.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _create(uint256 pk, address from, uint256 buyIn, IGameRules rules_, uint256 stake, uint64 clock, address channelKey, uint256[2] memory deckKey)
        internal
        returns (bytes32 tableId)
    {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), rules_, buyIn, stake, clock, channelKey, deckKey, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(pk, from, buyIn, nonce);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), buyIn, rules_, stake, clock, channelKey, deckKey, auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey);
        ZkTable.DepositAuth memory auth = _authFor(pk, from, stake, nonce);
        vm.prank(from);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    function _deployReveal() internal returns (address addr) {
        addr = makeAddr("revealVerifier");
        deployCodeTo("RevealVerifier.sol:RevealVerifier", addr);
    }

    function _gen(uint32 deckIndex) internal returns (Fixture memory f) {
        string[] memory cmd = new string[](3);
        cmd[0] = "../../node_modules/.bin/tsx";
        cmd[1] = "../zk-core/scripts/gen-showdown-dispute.mts";
        cmd[2] = vm.toString(uint256(deckIndex));
        bytes memory res = vm.ffi(cmd);
        (f.deckKeyA, f.deckKeyB, f.deck, f.deckCommitment, f.revealsFlat, f.proofsFlat) =
            abi.decode(res, (uint256[2], uint256[2], uint256[], bytes32, uint256[], uint256[]));
    }

    function _hiloGameState(uint32 deckIndex) internal pure returns (bytes memory) {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.deckIndex = deckIndex;
        return abi.encode(s);
    }

    function _coSign(ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK_A, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK_B, digest);
        sigA = abi.encodePacked(r1, s1, v1);
        sigB = abi.encodePacked(r2, s2, v2);
    }

    function _status(bytes32 id) internal view returns (ChannelTableBase.Status status) {
        (, , , , , , , , , status, , , , , , , , , ) = zk.tables(id);
    }

    /// create + join with the fixture's real deck keys, then open a DEMAND_SHOWDOWN dispute
    /// (disputant A) at DECK_INDEX. Escrow 2+2 ETH; balances 1.5/1.5, pot 1 ETH.
    function _setupDisputed(Fixture memory f) internal returns (bytes32 tableId, bytes memory gameState) {
        tableId = _create(PK_A, a, ESCROW, IGameRules(address(rules)), ESCROW, CLOCK, address(0), f.deckKeyA);
        _join(PK_B, b, tableId, ESCROW, address(0), f.deckKeyB);

        gameState = _hiloGameState(DECK_INDEX);
        ChannelState memory s;
        s.tableId = tableId;
        s.nonce = 1;
        s.balanceA = 1.5 ether;
        s.balanceB = 1.5 ether;
        s.pot = 1 ether;
        s.deckCommitment = f.deckCommitment;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        vm.prank(a);
        zk.openDispute(tableId, s, sigA, sigB, gameState, DEMAND_SHOWDOWN, 0);
        assertEq(uint8(_status(tableId)), uint8(ChannelTableBase.Status.Disputed), "disputed");
    }

    /// THE headline test: full real-crypto deadlock-closing sequence + payout. Both seats post
    /// their two reveals in ONE call each via the unified postShowdownReveals.
    function test_showdownDeadlock_closesAndPaysRankCorrectWinner() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, bytes memory gameState) = _setupDisputed(f);

        // disputant A posts its own two shares in one call
        vm.prank(a);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 0), _reveal(f, 2)], [_proof(f, 0), _proof(f, 2)]);
        assertEq(uint8(_status(tableId)), uint8(ChannelTableBase.Status.Disputed), "disputed after A's own reveals");

        // counterparty B posts its own two real Groth16-verified shares — real on-chain verifier.
        // This leaves the table Disputed, NOT Live: this is the deadlock fix. (The old
        // respondWithShare would have flipped straight to Live on the very first matching
        // answer, with no route to a payout at all.)
        vm.prank(b);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 1), _reveal(f, 3)], [_proof(f, 1), _proof(f, 3)]);
        assertEq(uint8(_status(tableId)), uint8(ChannelTableBase.Status.Disputed), "still disputed, finalize is a separate step");

        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);

        vm.expectEmit(true, false, false, true);
        emit ZkTable.ShowdownFinalized(tableId, 3, 4, 2); // cardA=3(rank0), cardB=4(rank1) -> B
        zk.finalizeShowdown(tableId, f.deck, gameState); // permissionless — no seat restriction

        assertEq(uint8(_status(tableId)), uint8(ChannelTableBase.Status.Settled));
        assertEq(token.balanceOf(a) - beforeA, 1.5 ether, "A keeps only its balance");
        assertEq(token.balanceOf(b) - beforeB, 1.5 ether + 1 ether, "B (rank winner) gets balance + pot");
        assertEq((token.balanceOf(a) - beforeA) + (token.balanceOf(b) - beforeB), ESCROW * 2, "conservation: no dust");
    }

    /// HEADLINE FIX (free-roll closed), real crypto both directions:
    /// counterparty fully reveals (real Groth16 proofs); disputant posts nothing (the free-roll
    /// attempt — decrypt off-chain from B's now-public shares, only finalize if it would win).
    /// Timeout must pay the COUNTERPARTY, not the silent disputant.
    function test_resolveTimeout_cpAnsweredOnly_potToCounterparty_freeRollClosed_realCrypto() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, ) = _setupDisputed(f);

        vm.prank(b);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 1), _reveal(f, 3)], [_proof(f, 1), _proof(f, 3)]);

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        zk.resolveTimeout(tableId);

        assertEq(token.balanceOf(b) - beforeB, 1.5 ether + 1 ether, "counterparty answered -> gets balance + pot");
        assertEq(token.balanceOf(a) - beforeA, 1.5 ether, "disputant refused to reveal -> only its balance, NOT the pot");
    }

    /// Mirror direction: disputant fully reveals, counterparty posts nothing -> pot to disputant.
    function test_resolveTimeout_dispAnsweredOnly_potToDisputant_realCrypto() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, ) = _setupDisputed(f);

        vm.prank(a);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 0), _reveal(f, 2)], [_proof(f, 0), _proof(f, 2)]);

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        zk.resolveTimeout(tableId);

        assertEq(token.balanceOf(a) - beforeA, 1.5 ether + 1 ether, "disputant answered -> gets balance + pot");
        assertEq(token.balanceOf(b) - beforeB, 1.5 ether, "counterparty refused -> only its balance");
    }

    /// Once both seats fully revealed, resolveTimeout must refuse (MustFinalize) even past the
    /// deadline — a fully-revealed showdown is never timeout-gameable.
    function test_resolveTimeout_bothAnswered_revertsMustFinalize_realCrypto() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, ) = _setupDisputed(f);

        vm.prank(a);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 0), _reveal(f, 2)], [_proof(f, 0), _proof(f, 2)]);
        vm.prank(b);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 1), _reveal(f, 3)], [_proof(f, 1), _proof(f, 3)]);

        vm.roll(block.number + CLOCK + 1);
        vm.expectRevert(ZkTable.MustFinalize.selector);
        zk.resolveTimeout(tableId);
    }

    /// A tampered snark proof is rejected by the REAL vendored verifier. Slot A's proof is
    /// tampered so postShowdownReveals reverts on its first internal _verifyAndStoreReveal call.
    function test_tamperedProof_revertsBadProof_realVerifier() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, ) = _setupDisputed(f);

        uint256[8] memory tampered = _proof(f, 1);
        tampered[0] ^= 1;

        vm.prank(b);
        vm.expectRevert(ZkTable.BadProof.selector);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 1), _reveal(f, 3)], [tampered, _proof(f, 3)]);
    }

    /// A's genuine reveal+proof, submitted by B's seat, fails: the pi fed to the verifier is
    /// keyed on the CALLER's registered deckKey (deckKeys[tableId][seat]), which for seat B is
    /// B's real key — not the key the proof actually witnesses (A's). The real Groth16 verifier
    /// rejects the mismatched public input.
    function test_proofUnderWrongSeatKey_revertsBadProof_realVerifier() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, ) = _setupDisputed(f);

        vm.prank(b); // B's seat, but A's proof/reveal (index 0/2 were witnessed by A's sk)
        vm.expectRevert(ZkTable.BadProof.selector);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_A, SLOT_B], [_reveal(f, 0), _reveal(f, 2)], [_proof(f, 0), _proof(f, 2)]);
    }

    /// A valid proof for a slot the dispute did not demand (neither SLOT_A nor SLOT_B) is
    /// rejected before any crypto — BadDeck, not BadProof.
    function test_validProofForNonDemandedSlot_revertsBadDeck() public {
        Fixture memory f = _gen(DECK_INDEX);
        (bytes32 tableId, ) = _setupDisputed(f);

        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.postShowdownReveals(tableId, f.deck, [SLOT_B + 1, SLOT_B], [_reveal(f, 0), _reveal(f, 2)], [_proof(f, 0), _proof(f, 2)]);
    }
}
