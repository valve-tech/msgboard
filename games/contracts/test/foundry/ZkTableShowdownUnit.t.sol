// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";
import {MockRevealVerifier} from "../../contracts/test/MockRevealVerifier.sol";
import {HiLoWarRules} from "../../contracts/zk/HiLoWarRules.sol";
import {HiLo, HiLoCodec} from "./HiLoWarRules.t.sol";

/// @notice Fast (no --ffi) coverage for the DEMAND_SHOWDOWN dispute machinery that closes the
/// "forced-reveal-then-refuse-to-cosign" deadlock AND the disputant free-roll (resolveTimeout is
/// answer-aware — see ZkTable.sol's showdown section / resolveTimeout header for the truth
/// table). Plumbing paths use MockGameRules/MockRevealVerifier, mirroring the existing
/// respondWithShare unit-test pattern.
///
/// The finalizeShowdown conservation tests are the one place this file needs genuinely-correct
/// elliptic-curve points rather than arbitrary numbers: ShowdownDecodeLib's EdOnBN254 arithmetic
/// and CardTable52.decode() run for REAL regardless of any mock. The fixture constants below are
/// copied verbatim from a real run of games/zk-core/scripts/gen-showdown-dispute.mts (deckIndex 3
/// and 0) against the pinned zypher-game secret-engine npm package (version 0.3.0) — i.e. real
/// masked-deck / decryption-share points, the same ones the ffi-based ZkTableShowdownDispute.t.sol
/// regenerates fresh. Only the Groth16 PROOF check is mocked here (MockRevealVerifier.ok=true) to
/// keep this file ffi-free; the point arithmetic and card decode are exercised exactly as they
/// would be on mainnet. The resolveTimeout truth-table tests don't need real crypto at all (they
/// never reach decode) and use arbitrary reveal points with MockGameRules.
contract ZkTableShowdownUnitTest is Test {
    ZkTable internal zk;
    MockGameRules internal mockRules;
    HiLoWarRules internal hiloRules;
    MockRevealVerifier internal verifier;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    address internal a;
    address internal b;

    uint64 internal constant CLOCK = 30;
    uint256 internal constant ESCROW = 2 ether;
    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHOWDOWN = 3;
    uint8 internal constant SHOWDOWN_SPLIT = 3; // ZkTable's internal constant, mirrored for asserts
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];
    uint256[8] internal ZERO_PROOF;

    // ---- real Baby-JubJub fixture points (see contract header) ----
    // WIN fixture (deckIndex=3): slotA=3 (rank0), slotB=4 (rank1) -> seat B wins. (deckCommitment
    // is NOT hardcoded here — it must be computed over whatever full 208-word deck array a given
    // test actually submits, e.g. `_winDeck()`'s real-slots-plus-`_deck208()`-filler mix, which
    // differs from the original generator run's all-real deck; see `_openHiloShowdown`.)
    uint256 constant WIN_SLOTA_E1X = 0x2b8cfd91b905cae31d41e7dedf4a927ee3bc429aad7e344d59d2810d82876c32;
    uint256 constant WIN_SLOTA_E1Y = 0x2aaa6c24a758209e90aced1f10277b762a7c1115dbc0e16ac276fc2c671a861f;
    uint256 constant WIN_SLOTA_E2X = 0x26338b9f5d1aac2e497db78e198b14646e0fb22fa79d7e16efa18e67aac55310;
    uint256 constant WIN_SLOTA_E2Y = 0x0eebe55fbd884feb925b997814d944fb3523f96a99ca322a21bf48b9b17f41c2;
    uint256 constant WIN_SLOTB_E1X = 0x2b8cfd91b905cae31d41e7dedf4a927ee3bc429aad7e344d59d2810d82876c32;
    uint256 constant WIN_SLOTB_E1Y = 0x2aaa6c24a758209e90aced1f10277b762a7c1115dbc0e16ac276fc2c671a861f;
    uint256 constant WIN_SLOTB_E2X = 0x11779c195844a5c7967bdef78879a60f0562d1f9fd11224fd092fa87d57315f4;
    uint256 constant WIN_SLOTB_E2Y = 0x1bd253503c04bed46f9ea343cb680da3b1b99f9d5089bddb35c692fba3ace998;
    uint256 constant WIN_REVEAL_A_SLOTA_X = 0x02fd50fb8a256e27c607aa8e6cc7996a18461c6662647bb72322094dd9b6b560;
    uint256 constant WIN_REVEAL_A_SLOTA_Y = 0x0ac50fa0bf53270e0f6fa0fe97fdf040e6e3f3a90e593f2faeb37b4da6d63f3e;
    uint256 constant WIN_REVEAL_B_SLOTA_X = 0x25c76478bc2d1d24a4951eaf2f44b4ec6a88c4e4f49bdc64854c452eac0d94b3;
    uint256 constant WIN_REVEAL_B_SLOTA_Y = 0x2acc1e5b09ac1879a0259636d2fd3f48be6f2b40eef1ad6ec14b1ef6ace95d47;
    uint256 constant WIN_REVEAL_A_SLOTB_X = WIN_REVEAL_A_SLOTA_X; // e1 is shared across an
    uint256 constant WIN_REVEAL_A_SLOTB_Y = WIN_REVEAL_A_SLOTA_Y; // un-shuffled deck (r=1 => e1=G),
    uint256 constant WIN_REVEAL_B_SLOTB_X = WIN_REVEAL_B_SLOTA_X; // so reveal = sk*e1 = sk*G = pk
    uint256 constant WIN_REVEAL_B_SLOTB_Y = WIN_REVEAL_B_SLOTA_Y; // is identical for every slot.

    // TIE fixture (deckIndex=0): slotA=0 (rank0), slotB=1 (rank0) -> tie. (same deckCommitment
    // note as WIN above.)
    uint256 constant TIE_SLOTA_E1X = 0x2b8cfd91b905cae31d41e7dedf4a927ee3bc429aad7e344d59d2810d82876c32;
    uint256 constant TIE_SLOTA_E1Y = 0x2aaa6c24a758209e90aced1f10277b762a7c1115dbc0e16ac276fc2c671a861f;
    uint256 constant TIE_SLOTA_E2X = 0x0eb3c62afd01fe970a57934830c709dda7a5eaf1c7ddb721b1ab7a7a4c98c9bd;
    uint256 constant TIE_SLOTA_E2Y = 0x10e47fe809322076eea89dda7f8f9d4b594ad014ecd8f3bc0e3e32cc3c898e76;
    uint256 constant TIE_SLOTB_E1X = 0x2b8cfd91b905cae31d41e7dedf4a927ee3bc429aad7e344d59d2810d82876c32;
    uint256 constant TIE_SLOTB_E1Y = 0x2aaa6c24a758209e90aced1f10277b762a7c1115dbc0e16ac276fc2c671a861f;
    uint256 constant TIE_SLOTB_E2X = 0x23908279da4694055c75112c4833b7fb0f857bcc8503143e88df6df046fe4547;
    uint256 constant TIE_SLOTB_E2Y = 0x091c980ec7ce05149fcdf61851947b09559dee5a7b90937e9f54ea9287bedb5a;
    uint256 constant TIE_REVEAL_A_X = 0x1b123fa480e7be761d434281d529454145d871e73d443f7266232ef120f346a3;
    uint256 constant TIE_REVEAL_A_Y = 0x0bbaf726351d4dd8affbc67bea3cab53991d6b527862445302cb208f2f1d287c;
    uint256 constant TIE_REVEAL_B_X = 0x1d9d8833e0e18a0ecf2d506f364a497130a4bacb64e03ef844a3e6b1500bb49;
    uint256 constant TIE_REVEAL_B_Y = 0x2e0fb382bc9db60b05a06477d39181c5cae435c227cb6588a2669755813d211f;

    function setUp() public {
        zk = new ZkTable();
        mockRules = new MockGameRules();
        verifier = new MockRevealVerifier();
        hiloRules = new HiLoWarRules(address(verifier), address(0));
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        vm.deal(a, 1_000_000 ether);
        vm.deal(b, 1_000_000 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _emptyState(bytes32 tableId) internal pure returns (ChannelState memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
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

    function _escrows(bytes32 id) internal view returns (uint256 escA, uint256 escB) {
        (, , , , escA, escB, , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _demandKind(bytes32 id) internal view returns (uint8 kind) {
        (, , , , , , , , , , , , , , kind, , , , ) = zk.tables(id);
    }

    function _deadline(bytes32 id) internal view returns (uint64 dl) {
        (, , , , , , , , , , , , dl, , , , , , ) = zk.tables(id);
    }

    function _createJoin(IGameRules rules_, uint256 escrowA, uint256 stake) internal returns (bytes32 tableId) {
        vm.prank(a);
        tableId = zk.create{value: escrowA}(rules_, stake, CLOCK, address(0), ZERO_DECK);
        vm.prank(b);
        zk.join{value: stake}(tableId, address(0), ZERO_DECK);
    }

    function _deck208() internal pure returns (uint256[] memory deck) {
        deck = new uint256[](208);
        for (uint256 i = 0; i < 208; i++) deck[i] = i + 1;
    }

    function _hiloGameState(uint32 deckIndex) internal pure returns (bytes memory) {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.deckIndex = deckIndex;
        return abi.encode(s);
    }

    /// Posts BOTH of `who`'s showdown reveals in one call (the new unified entrypoint).
    function _post(bytes32 id, address who, uint256[] memory deck, uint32 s0, uint32 s1, uint256[2] memory r0, uint256[2] memory r1) internal {
        vm.prank(who);
        zk.postShowdownReveals(id, deck, [s0, s1], [r0, r1], [ZERO_PROOF, ZERO_PROOF]);
    }

    /// Opens a DEMAND_SHOWDOWN dispute (disputant A) against HiLoWarRules with a state whose
    /// deckCommitment matches `deck` (commitment is DERIVED from the exact deck passed in — the
    /// real fixture points only occupy the two showdown slots; the other 206 words are `_deck208`
    /// filler, so the commitment must be computed over THIS deck, not the original real deck's
    /// commitment from the generator run), at `deckIndex` (so showdownSlots = deckIndex,
    /// deckIndex+1). Escrow/balances conserve ESCROW*2; pot = 1 ether.
    function _openHiloShowdown(uint32 deckIndex, uint256[] memory deck) internal returns (bytes32 tableId, bytes memory gameState) {
        tableId = _createJoin(IGameRules(address(hiloRules)), ESCROW, ESCROW);
        gameState = _hiloGameState(deckIndex);
        ChannelState memory s = _emptyState(tableId);
        s.nonce = 1;
        s.balanceA = 1.5 ether;
        s.balanceB = 1.5 ether;
        s.pot = 1 ether;
        s.deckCommitment = keccak256(abi.encodePacked(deck));
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(tableId, s, sigA, sigB, gameState, DEMAND_SHOWDOWN, 0);
    }

    /// Opens a DEMAND_SHOWDOWN dispute (disputant A) against MockGameRules at (slotA, slotB),
    /// with the given deck/balances/pot (balA+balB+pot must equal 2*ESCROW).
    function _openMockShowdown(uint32 slotA, uint32 slotB, uint256[] memory deck, uint256 balA, uint256 balB, uint256 pot)
        internal
        returns (bytes32 tableId, bytes memory gameState)
    {
        mockRules.setShowdownSlots(true, slotA, slotB);
        mockRules.setRevealVerifier(address(verifier));
        tableId = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        gameState = "gs";
        ChannelState memory s = _emptyState(tableId);
        s.balanceA = balA;
        s.balanceB = balB;
        s.pot = pot;
        s.deckCommitment = keccak256(abi.encodePacked(deck));
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(tableId, s, sigA, sigB, gameState, DEMAND_SHOWDOWN, 0);
    }

    function _winDeck() internal pure returns (uint256[] memory deck) {
        deck = _deck208();
        deck[4 * 3] = WIN_SLOTA_E1X;
        deck[4 * 3 + 1] = WIN_SLOTA_E1Y;
        deck[4 * 3 + 2] = WIN_SLOTA_E2X;
        deck[4 * 3 + 3] = WIN_SLOTA_E2Y;
        deck[4 * 4] = WIN_SLOTB_E1X;
        deck[4 * 4 + 1] = WIN_SLOTB_E1Y;
        deck[4 * 4 + 2] = WIN_SLOTB_E2X;
        deck[4 * 4 + 3] = WIN_SLOTB_E2Y;
    }

    function _tieDeck() internal pure returns (uint256[] memory deck) {
        deck = _deck208();
        deck[4 * 0] = TIE_SLOTA_E1X;
        deck[4 * 0 + 1] = TIE_SLOTA_E1Y;
        deck[4 * 0 + 2] = TIE_SLOTA_E2X;
        deck[4 * 0 + 3] = TIE_SLOTA_E2Y;
        deck[4 * 1] = TIE_SLOTB_E1X;
        deck[4 * 1 + 1] = TIE_SLOTB_E1Y;
        deck[4 * 1 + 2] = TIE_SLOTB_E2X;
        deck[4 * 1 + 3] = TIE_SLOTB_E2Y;
    }

    /// Places the given (e1x,e1y,e2x,e2y) word blocks at slotA/slotB of an otherwise-filler deck.
    function _deckWithSlots(uint32 slotA, uint32 slotB, uint256[4] memory blockA, uint256[4] memory blockB)
        internal
        pure
        returns (uint256[] memory deck)
    {
        deck = _deck208();
        deck[4 * slotA] = blockA[0];
        deck[4 * slotA + 1] = blockA[1];
        deck[4 * slotA + 2] = blockA[2];
        deck[4 * slotA + 3] = blockA[3];
        deck[4 * slotB] = blockB[0];
        deck[4 * slotB + 1] = blockB[1];
        deck[4 * slotB + 2] = blockB[2];
        deck[4 * slotB + 3] = blockB[3];
    }

    // ═══════════════════════════════════════════════════════════════════════
    // openDispute(DEMAND_SHOWDOWN)
    // ═══════════════════════════════════════════════════════════════════════

    function test_openDispute_showdown_revertsBadDemand_whenRulesIneligible() public {
        mockRules.setShowdownSlots(false, 0, 0);
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        ChannelState memory s = _emptyState(id);
        s.balanceB = 2 * ESCROW;
        s.deckCommitment = keccak256("deck");
        s.gameStateHash = keccak256("gs");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(id, s, sigA, sigB, "gs", DEMAND_SHOWDOWN, 0);
    }

    function test_openDispute_showdown_revertsBadDemand_noDeckCommitment() public {
        mockRules.setShowdownSlots(true, 0, 1);
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        ChannelState memory s = _emptyState(id);
        s.balanceB = 2 * ESCROW; // deckCommitment left at bytes32(0)
        s.gameStateHash = keccak256("gs");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(id, s, sigA, sigB, "gs", DEMAND_SHOWDOWN, 0);
    }

    function test_openDispute_showdown_revertsBadDemand_slotsOutOfRangeOrEqual() public {
        mockRules.setShowdownSlots(true, 51, 52); // 52 > 51
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        ChannelState memory s = _emptyState(id);
        s.balanceB = 2 * ESCROW;
        s.deckCommitment = keccak256("deck");
        s.gameStateHash = keccak256("gs");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(id, s, sigA, sigB, "gs", DEMAND_SHOWDOWN, 0);
    }

    function test_openDispute_showdown_succeeds() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed));
        assertEq(_demandKind(id), DEMAND_SHOWDOWN);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // postShowdownReveals — plumbing
    // ═══════════════════════════════════════════════════════════════════════

    function test_postShowdownReveals_revertsBadStatus_notDisputed() public {
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.postShowdownReveals(id, _deck208(), [uint32(0), uint32(1)], [[uint256(1), uint256(2)], [uint256(3), uint256(4)]], [ZERO_PROOF, ZERO_PROOF]);
    }

    function test_postShowdownReveals_revertsNotDemanded_whenMoveDispute() public {
        mockRules.setFinalAll(true);
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        ChannelState memory s = _emptyState(id);
        s.balanceB = 2 * ESCROW;
        s.gameStateHash = keccak256("gs");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, "gs", DEMAND_MOVE, 0);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.NotDemanded.selector);
        zk.postShowdownReveals(id, _deck208(), [uint32(0), uint32(1)], [[uint256(1), uint256(2)], [uint256(3), uint256(4)]], [ZERO_PROOF, ZERO_PROOF]);
    }

    function test_postShowdownReveals_revertsBadDeck_nonDemandedSlot() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.postShowdownReveals(
            id, _winDeck(), [uint32(7), uint32(4)],
            [[WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]],
            [ZERO_PROOF, ZERO_PROOF]
        );
    }

    function test_postShowdownReveals_revertsBadDeck_wrongDeckBytes() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        uint256[] memory badDeck = _winDeck();
        badDeck[0] ^= 1; // breaks the commitment binding
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.postShowdownReveals(
            id, badDeck, [uint32(3), uint32(4)],
            [[WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]],
            [ZERO_PROOF, ZERO_PROOF]
        );
    }

    function test_postShowdownReveals_revertsBadProof_whenVerifierRejects() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        verifier.setOk(false); // stand-in for a forged/tampered proof or the wrong seat's key
        vm.prank(a);
        vm.expectRevert(ZkTable.BadProof.selector);
        zk.postShowdownReveals(
            id, _winDeck(), [uint32(3), uint32(4)],
            [[WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]],
            [ZERO_PROOF, ZERO_PROOF]
        );
    }

    function test_postShowdownReveals_revertsAlreadyRevealed_onDuplicateCall() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        uint256[] memory deck = _winDeck();
        _post(id, a, deck, 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        vm.prank(a);
        vm.expectRevert(ZkTable.AlreadyRevealed.selector);
        zk.postShowdownReveals(
            id, deck, [uint32(3), uint32(4)],
            [[WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]],
            [ZERO_PROOF, ZERO_PROOF]
        );
    }

    function test_postShowdownReveals_emitsShowdownRevealStored() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        vm.expectEmit(true, false, false, true);
        emit ZkTable.ShowdownRevealStored(id, 3, 1, WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y);
        _post(id, a, _winDeck(), 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
    }

    function test_postShowdownReveals_extendsDeadline() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        uint64 before = _deadline(id);
        vm.roll(block.number + CLOCK - 2); // just short of the original deadline
        _post(id, a, _winDeck(), 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        uint64 afterDl = _deadline(id);
        assertGt(afterDl, before, "posting reveals must extend the dispute clock");
        assertEq(afterDl, uint64(block.number) + CLOCK, "extended to a fresh full clockBlocks window");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // finalizeShowdown — completeness gate + conservation (real EC math)
    // ═══════════════════════════════════════════════════════════════════════

    function test_finalizeShowdown_revertsRevealsIncomplete_oneSeatOnly() public {
        (bytes32 id, bytes memory gameState) = _openHiloShowdown(3, _winDeck());
        uint256[] memory deck = _winDeck();
        // only A (2 of 4) answers; B never does
        _post(id, a, deck, 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        vm.expectRevert(ZkTable.RevealsIncomplete.selector);
        zk.finalizeShowdown(id, deck, gameState);
    }

    /// DEADLOCK-CLOSING sequence (mocked proof, real EC math): both seats post their own two
    /// shares via postShowdownReveals; finalizeShowdown then pays the rank-correct winner.
    /// finalizeShowdown is callable by anyone (no seat/caller restriction) once complete.
    function test_finalizeShowdown_win_paysRankCorrectWinner_conserves() public {
        (bytes32 id, bytes memory gameState) = _openHiloShowdown(3, _winDeck());
        uint256[] memory deck = _winDeck();

        _post(id, a, deck, 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        // still Disputed after the disputant's own reveals — no premature clear
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed), "disputed mid-reveal");

        _post(id, b, deck, 3, 4, [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y], [WIN_REVEAL_B_SLOTB_X, WIN_REVEAL_B_SLOTB_Y]);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed), "still disputed, finalize is a separate step");

        (uint256 escABefore, uint256 escBBefore) = _escrows(id);
        uint256 total = escABefore + escBBefore;
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;

        vm.expectEmit(true, false, false, true);
        emit ZkTable.ShowdownFinalized(id, 3, 4, 2); // cardA=3 (rank0), cardB=4 (rank1) -> B wins
        zk.finalizeShowdown(id, deck, gameState); // called by neither seat — permissionless

        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Settled));
        uint256 paidA = a.balance - beforeA;
        uint256 paidB = b.balance - beforeB;
        assertEq(paidA, 1.5 ether, "A keeps only its balance (loses the pot)");
        assertEq(paidB, 1.5 ether + 1 ether, "B gets its balance + the pot");
        assertEq(paidA + paidB, total, "conservation: full escrow paid out, no dust");
    }

    /// Tie (equal rank) forfeits the pot to the disputant, mirroring resolveTimeout's
    /// undecided-terminal branch (see finalizeShowdown's header comment on this choice).
    function test_finalizeShowdown_tie_forfeitsToDisputant_conserves() public {
        (bytes32 id, bytes memory gameState) = _openHiloShowdown(0, _tieDeck());
        uint256[] memory deck = _tieDeck();

        _post(id, a, deck, 0, 1, [TIE_REVEAL_A_X, TIE_REVEAL_A_Y], [TIE_REVEAL_A_X, TIE_REVEAL_A_Y]);
        _post(id, b, deck, 0, 1, [TIE_REVEAL_B_X, TIE_REVEAL_B_Y], [TIE_REVEAL_B_X, TIE_REVEAL_B_Y]);

        (uint256 escABefore, uint256 escBBefore) = _escrows(id);
        uint256 total = escABefore + escBBefore;
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;

        vm.expectEmit(true, false, false, true);
        emit ZkTable.ShowdownFinalized(id, 0, 1, 0); // rank tie
        zk.finalizeShowdown(id, deck, gameState);

        uint256 paidA = a.balance - beforeA;
        uint256 paidB = b.balance - beforeB;
        assertEq(paidA, 1.5 ether + 1 ether, "disputant A gets its balance + the pot on a tie");
        assertEq(paidB, 1.5 ether, "B keeps only its balance");
        assertEq(paidA + paidB, total, "conservation: full escrow paid out, no dust");
    }

    /// Same WIN fixture, but with a deliberately odd-wei escrow/balance/pot split — conservation
    /// must hold exactly (no rounding, no dust) down to the last wei.
    function test_finalizeShowdown_win_conservesOddWei() public {
        uint256 escrowA = 1.23456789 ether + 1; // odd wei
        uint256 escrowB = 2.3456789 ether + 3; // odd wei
        bytes32 id = _createJoin(IGameRules(address(hiloRules)), escrowA, escrowB);
        bytes memory gameState = _hiloGameState(3);
        uint256[] memory deck = _winDeck();

        uint256 pot = 777 wei;
        uint256 balA = 1 wei;
        uint256 balB = (escrowA + escrowB) - pot - balA; // exact conservation, odd wei
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = balA;
        s.balanceB = balB;
        s.pot = pot;
        s.deckCommitment = keccak256(abi.encodePacked(deck));
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, DEMAND_SHOWDOWN, 0);

        _post(id, a, deck, 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        _post(id, b, deck, 3, 4, [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y], [WIN_REVEAL_B_SLOTB_X, WIN_REVEAL_B_SLOTB_Y]);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.finalizeShowdown(id, deck, gameState);

        uint256 paidA = a.balance - beforeA;
        uint256 paidB = b.balance - beforeB;
        assertEq(paidA, balA, "A (loser) keeps exactly its balance, to the wei");
        assertEq(paidB, balB + pot, "B (winner) gets exactly balance + pot, to the wei");
        assertEq(paidA + paidB, escrowA + escrowB, "conservation holds exactly, no dust, odd wei");
    }

    /// ANTI-THEFT FALLBACK: a decoy/garbage deck key at slotA makes that slot decrypt to a point
    /// outside the fixed 52-card table (CardTable52 reports ok=false). finalizeShowdown must NOT
    /// revert (that would strand both seats' funds) and must NOT forfeit the whole pot to either
    /// side — it SPLITS. Odd-wei pot to exercise the split's own conservation exactly.
    function test_finalizeShowdown_badDecode_splitsPot_conserves() public {
        uint32 slotA = 10;
        uint32 slotB = 11;
        // garbage e1/e2 at slotA: near-certainly not any of the 52 table points.
        uint256[4] memory garbage = [uint256(1), uint256(2), uint256(111), uint256(222)];
        uint256[4] memory tieBlock = [TIE_SLOTA_E1X, TIE_SLOTA_E1Y, TIE_SLOTA_E2X, TIE_SLOTA_E2Y];
        uint256[] memory deck = _deckWithSlots(slotA, slotB, garbage, tieBlock);

        uint256 pot = 1 ether + 1; // odd wei
        uint256 balA = 1 ether;
        uint256 balB = 2 * ESCROW - pot - balA;
        (bytes32 id, bytes memory gameState) = _openMockShowdown(slotA, slotB, deck, balA, balB, pot);

        _post(id, a, deck, slotA, slotB, [uint256(5), uint256(6)], [TIE_REVEAL_A_X, TIE_REVEAL_A_Y]);
        _post(id, b, deck, slotA, slotB, [uint256(7), uint256(8)], [TIE_REVEAL_B_X, TIE_REVEAL_B_Y]);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;

        vm.expectEmit(true, false, false, false); // only check tableId; cardA is meaningless (ok=false)
        emit ZkTable.ShowdownFinalized(id, 0, 0, SHOWDOWN_SPLIT);
        zk.finalizeShowdown(id, deck, gameState);

        uint256 half = pot / 2;
        uint256 paidA = a.balance - beforeA;
        uint256 paidB = b.balance - beforeB;
        assertEq(paidA, balA + half + 1, "A gets balance + half pot + odd wei");
        assertEq(paidB, balB + half, "B gets balance + half pot");
        assertLt(paidA, balA + pot, "disputant (A) must NOT get the whole pot from a decoy key");
        assertEq(paidA + paidB, 2 * ESCROW, "conservation holds exactly on the split fallback, no dust");
    }

    /// A stacked/duplicated deck — both slots decrypt successfully but to the SAME card index —
    /// is also treated as a malformed showdown and SPLITS, never forfeits to either side.
    function test_finalizeShowdown_duplicateCard_splitsPot_conserves() public {
        uint32 slotA = 10;
        uint32 slotB = 11;
        uint256[4] memory winBlock = [WIN_SLOTA_E1X, WIN_SLOTA_E1Y, WIN_SLOTA_E2X, WIN_SLOTA_E2Y];
        // both slots reuse the SAME masked-card block -> both decode to card index 3
        uint256[] memory deck = _deckWithSlots(slotA, slotB, winBlock, winBlock);

        uint256 pot = 1 ether;
        uint256 balA = 1.5 ether;
        uint256 balB = 2 * ESCROW - pot - balA;
        (bytes32 id, bytes memory gameState) = _openMockShowdown(slotA, slotB, deck, balA, balB, pot);

        _post(id, a, deck, slotA, slotB, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y]);
        _post(id, b, deck, slotA, slotB, [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y], [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y]);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;

        vm.expectEmit(true, false, false, true);
        emit ZkTable.ShowdownFinalized(id, 3, 3, SHOWDOWN_SPLIT); // both decode ok, but cardA==cardB
        zk.finalizeShowdown(id, deck, gameState);

        uint256 half = pot / 2;
        uint256 paidA = a.balance - beforeA;
        uint256 paidB = b.balance - beforeB;
        assertEq(paidA, balA + half, "A gets balance + half pot (pot is even here)");
        assertEq(paidB, balB + half, "B gets balance + half pot");
        assertEq(paidA + paidB, 2 * ESCROW, "conservation holds exactly on the duplicate-card split");
    }

    /// Exercises MockGameRules.setShowdownWinner directly: two DIFFERENT real cards decode
    /// successfully (so showdownResult is actually consulted), and the mock's configured winner
    /// drives the payout. winner=3 must revert BadGameState (mirrors the A3 result() guard at
    /// openDispute — showdownResult is only ever allowed to name a real seat or a tie).
    function _openWinnerGuardShowdown(uint256 balA, uint256 balB, uint256 pot) internal returns (bytes32 id, bytes memory gameState, uint256[] memory deck) {
        uint32 slotA = 20;
        uint32 slotB = 21;
        uint256[4] memory winBlock = [WIN_SLOTA_E1X, WIN_SLOTA_E1Y, WIN_SLOTA_E2X, WIN_SLOTA_E2Y]; // decodes to 3
        uint256[4] memory tieBlock = [TIE_SLOTA_E1X, TIE_SLOTA_E1Y, TIE_SLOTA_E2X, TIE_SLOTA_E2Y]; // decodes to 0
        deck = _deckWithSlots(slotA, slotB, winBlock, tieBlock);
        (id, gameState) = _openMockShowdown(slotA, slotB, deck, balA, balB, pot);
        _post(id, a, deck, slotA, slotB, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [TIE_REVEAL_A_X, TIE_REVEAL_A_Y]);
        _post(id, b, deck, slotA, slotB, [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y], [TIE_REVEAL_B_X, TIE_REVEAL_B_Y]);
    }

    function test_finalizeShowdown_mockWinner1_paysA() public {
        mockRules.setShowdownWinner(1);
        (bytes32 id, bytes memory gameState, uint256[] memory deck) = _openWinnerGuardShowdown(1.5 ether, 1.5 ether, 1 ether);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.finalizeShowdown(id, deck, gameState);
        assertEq(a.balance - beforeA, 2.5 ether, "winner=1 pays A balance + pot");
        assertEq(b.balance - beforeB, 1.5 ether, "B gets only its balance");
    }

    function test_finalizeShowdown_mockWinner2_paysB() public {
        mockRules.setShowdownWinner(2);
        (bytes32 id, bytes memory gameState, uint256[] memory deck) = _openWinnerGuardShowdown(1.5 ether, 1.5 ether, 1 ether);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.finalizeShowdown(id, deck, gameState);
        assertEq(b.balance - beforeB, 2.5 ether, "winner=2 pays B balance + pot");
        assertEq(a.balance - beforeA, 1.5 ether, "A gets only its balance");
    }

    function test_finalizeShowdown_mockWinner3_revertsBadGameState() public {
        mockRules.setShowdownWinner(3); // out of range: only 0 (tie), 1, 2 are valid
        (bytes32 id, bytes memory gameState, uint256[] memory deck) = _openWinnerGuardShowdown(1.5 ether, 1.5 ether, 1 ether);
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.finalizeShowdown(id, deck, gameState);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // unverified cards never settle (A3 non-regression for respondWithMove)
    // ═══════════════════════════════════════════════════════════════════════

    /// respondWithMove (the pre-existing, unrelated demand kind) still ONLY emits and clears the
    /// dispute — no payout, ever — even when the "move" payload encodes fabricated MOVE_SHOWDOWN
    /// cards designed to make the caller look like the winner. This is the invariant the whole
    /// showdown feature must never violate: only snark-verified reveals (via
    /// postShowdownReveals) may ever feed finalizeShowdown/resolveTimeout/_payout.
    function test_respondWithMove_fakeShowdownCards_neverPays() public {
        mockRules.setFinalAll(true);
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _emptyState(id);
        s.balanceB = 2 * ESCROW;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0);

        // B (the counterparty) answers with a MOVE payload that claims a fabricated favorable
        // showdown result — MockGameRules.applyMove ignores the payload content entirely and
        // just returns whatever `nextState` was configured, matching the production rules
        // contracts' behavior of not being consulted by ZkTable for any payout.
        bytes memory fakeMove = abi.encode(uint8(5) /* MOVE_SHOWDOWN */, abi.encode(uint8(51), uint8(0)));
        bytes memory nextState = abi.encode("gs2");
        mockRules.setApply(nextState, false);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        uint256 contractBefore = address(zk).balance;

        vm.prank(b);
        zk.respondWithMove(id, gameState, fakeMove);

        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live), "dispute cleared, not settled");
        assertEq(a.balance, beforeA, "no payout to A");
        assertEq(b.balance, beforeB, "no payout to B");
        assertEq(address(zk).balance, contractBefore, "escrow untouched");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // newer-state defense: respondWithState wipes the reveal accumulator
    // ═══════════════════════════════════════════════════════════════════════

    function test_respondWithState_midShowdown_wipesRevealAccumulator() public {
        mockRules.setShowdownSlots(true, 3, 4);
        mockRules.setRevealVerifier(address(verifier));
        bytes32 id = _createJoin(IGameRules(address(mockRules)), ESCROW, ESCROW);

        bytes memory gs1 = abi.encode("gs1");
        ChannelState memory s1 = _emptyState(id);
        s1.nonce = 1;
        s1.balanceB = 2 * ESCROW;
        s1.deckCommitment = keccak256(abi.encodePacked(_winDeck()));
        s1.gameStateHash = keccak256(gs1);
        (bytes memory sigA1, bytes memory sigB1) = _coSign(s1);
        vm.prank(a);
        zk.openDispute(id, s1, sigA1, sigB1, gs1, DEMAND_SHOWDOWN, 0);

        uint256[] memory deck = _winDeck();
        // A fully answers (haveMask = 0x05) in the FIRST dispute cycle.
        _post(id, a, deck, 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);

        // a newer co-signed state clears the dispute back to Live
        ChannelState memory s2 = _emptyState(id);
        s2.nonce = 2;
        s2.balanceB = 2 * ESCROW;
        (bytes memory sigA2, bytes memory sigB2) = _coSign(s2);
        vm.prank(b);
        zk.respondWithState(id, s2, sigA2, sigB2);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));

        // re-open a SECOND showdown dispute on the same two slots
        bytes memory gs3 = abi.encode("gs3");
        ChannelState memory s3 = _emptyState(id);
        s3.nonce = 3;
        s3.balanceB = 2 * ESCROW;
        s3.deckCommitment = keccak256(abi.encodePacked(_winDeck()));
        s3.gameStateHash = keccak256(gs3);
        (bytes memory sigA3, bytes memory sigB3) = _coSign(s3);
        vm.prank(a);
        zk.openDispute(id, s3, sigA3, sigB3, gs3, DEMAND_SHOWDOWN, 0);

        // this time only B fully answers (haveMask = 0x0A). If A's first-cycle bits (0x05) had
        // survived, the mapping would show 0x05 | 0x0A == 0x0F ("complete") without A ever
        // answering in THIS cycle. It must not.
        _post(id, b, deck, 3, 4, [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y], [WIN_REVEAL_B_SLOTB_X, WIN_REVEAL_B_SLOTB_Y]);

        vm.expectRevert(ZkTable.RevealsIncomplete.selector);
        zk.finalizeShowdown(id, deck, gs3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // resolveTimeout — answer-aware truth table (closes the disputant free-roll)
    // ═══════════════════════════════════════════════════════════════════════

    function _openTimeoutShowdown(uint256 pot) internal returns (bytes32 id, uint256[] memory deck, uint256 balA, uint256 balB) {
        deck = _deck208();
        balA = 1.5 ether;
        balB = 2 * ESCROW - pot - balA;
        (id, ) = _openMockShowdown(0, 1, deck, balA, balB, pot);
    }

    /// Disputant fully reveals; counterparty posts nothing -> pot to the disputant (counterparty
    /// refused to reveal what it owed).
    function test_resolveTimeout_showdown_dispAnsweredOnly_potToDisputant() public {
        (bytes32 id, uint256[] memory deck, uint256 balA, uint256 balB) = _openTimeoutShowdown(1 ether);
        _post(id, a, deck, 0, 1, [uint256(1), uint256(2)], [uint256(3), uint256(4)]); // A == disputant

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.resolveTimeout(id);

        assertEq(a.balance - beforeA, balA + 1 ether, "disputant answered -> gets balance + pot");
        assertEq(b.balance - beforeB, balB, "counterparty refused -> gets only its balance");
    }

    /// HEADLINE FIX: counterparty fully reveals; the DISPUTANT posts nothing (the free-roll
    /// attempt — decrypt off-chain from the counterparty's now-public shares, only finalize if
    /// it would win, else silently let the clock run). Timeout must pay the COUNTERPARTY, not
    /// the silent disputant. This test MUST fail against the pre-fix demand-kind-agnostic
    /// forfeit-to-disputant timeout (see the PR report for the exact pre-fix trace).
    function test_resolveTimeout_showdown_cpAnsweredOnly_potToCounterparty_freeRollClosed() public {
        (bytes32 id, uint256[] memory deck, uint256 balA, uint256 balB) = _openTimeoutShowdown(1 ether);
        _post(id, b, deck, 0, 1, [uint256(5), uint256(6)], [uint256(7), uint256(8)]); // B == counterparty

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.resolveTimeout(id);

        assertEq(b.balance - beforeB, balB + 1 ether, "counterparty answered -> gets balance + pot (free-roll closed)");
        assertEq(a.balance - beforeA, balA, "disputant refused to reveal -> gets only its balance, NOT the pot");
    }

    /// Neither seat reveals: mutual no-show splits the pot (denies either side a griefing edge)
    /// rather than handing it to whichever seat happens to be `disputant`. Odd-wei pot to
    /// exercise the split's own conservation.
    function test_resolveTimeout_showdown_neitherAnswered_splitsPot_conserves() public {
        uint256 pot = 1 ether + 1; // odd wei
        (bytes32 id, , uint256 balA, uint256 balB) = _openTimeoutShowdown(pot);

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.resolveTimeout(id);

        uint256 half = pot / 2;
        uint256 paidA = a.balance - beforeA;
        uint256 paidB = b.balance - beforeB;
        assertEq(paidA, balA + half + 1, "A gets balance + half pot + odd wei");
        assertEq(paidB, balB + half, "B gets balance + half pot");
        assertEq(paidA + paidB, 2 * ESCROW, "conservation holds exactly on mutual-no-show split");
    }

    /// Both seats fully revealed (haveMask == 0x0F): resolveTimeout must refuse and point callers
    /// at finalizeShowdown instead — a fully-revealed showdown is never timeout-gameable.
    function test_resolveTimeout_showdown_bothAnswered_revertsMustFinalize() public {
        (bytes32 id, uint256[] memory deck, , ) = _openTimeoutShowdown(1 ether);
        _post(id, a, deck, 0, 1, [uint256(1), uint256(2)], [uint256(3), uint256(4)]);
        _post(id, b, deck, 0, 1, [uint256(5), uint256(6)], [uint256(7), uint256(8)]);

        vm.roll(block.number + CLOCK + 1);
        vm.expectRevert(ZkTable.MustFinalize.selector);
        zk.resolveTimeout(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // gas ceilings
    // ═══════════════════════════════════════════════════════════════════════

    // Measured (gasleft() delta around the call, mocked verifier so the snark-check cost is
    // excluded — that path is covered separately by ZkGas.test.ts's verifyRevealWithSnark
    // ceiling): postShowdownReveals (cold SSTOREs: first showdowns-mapping writes + the deadline
    // extension, both slots in one call) ~197k; finalizeShowdown (warm, after 4 prior reveal
    // writes) ~70.8k. Ceilings set with ~35-40% margin.
    uint256 internal constant POST_REVEALS_CEILING = 270_000;
    uint256 internal constant FINALIZE_SHOWDOWN_CEILING = 100_000;

    function test_gas_postShowdownReveals() public {
        (bytes32 id, ) = _openHiloShowdown(3, _winDeck());
        uint256 g0 = gasleft();
        _post(id, a, _winDeck(), 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        uint256 gasUsed = g0 - gasleft();
        assertLt(gasUsed, POST_REVEALS_CEILING, "postShowdownReveals gas regression");
    }

    function test_gas_finalizeShowdown() public {
        (bytes32 id, bytes memory gameState) = _openHiloShowdown(3, _winDeck());
        uint256[] memory deck = _winDeck();
        _post(id, a, deck, 3, 4, [WIN_REVEAL_A_SLOTA_X, WIN_REVEAL_A_SLOTA_Y], [WIN_REVEAL_A_SLOTB_X, WIN_REVEAL_A_SLOTB_Y]);
        _post(id, b, deck, 3, 4, [WIN_REVEAL_B_SLOTA_X, WIN_REVEAL_B_SLOTA_Y], [WIN_REVEAL_B_SLOTB_X, WIN_REVEAL_B_SLOTB_Y]);

        uint256 g0 = gasleft();
        zk.finalizeShowdown(id, deck, gameState);
        uint256 gasUsed = g0 - gasleft();
        assertLt(gasUsed, FINALIZE_SHOWDOWN_CEILING, "finalizeShowdown gas regression");
    }
}
