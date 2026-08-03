// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseChannel, OpenTerms} from "../../contracts/games/HouseChannel.sol";
import {HousePoolBase} from "../../contracts/games/HousePoolBase.sol";
import {SessionState, SessionClose} from "../../contracts/games/SessionState.sol";

/// Coverage-only unit suite for HouseChannel.sol (default profile, no contract changes).
///
/// Purpose: HouseChannel.t.sol / SettleWithSeeds.t.sol / SettleWithProof.t.sol already cover the
/// cooperative-close / dispute-clock / mode-1 recompute / mode-2 ZK happy+sad paths, but leave 7 of
/// HouseChannel's 19 errors untested (BadClock, Expired, WrongTable, BadMode, InsufficientPool,
/// BadProof, PayoutExceedsPot) and several individual revert *sites* uncovered even where the error
/// itself is exercised elsewhere (e.g. ConservationViolated/BadSig have TWO call sites each —
/// _checkCoSigned for the running dispute path and _checkCloseCoSigned for the cooperative-close
/// path — and only one side of each pair had a test). This file sweeps the remainder.
///
/// settleWithSeeds and settleWithProof are RE-EXERCISED here (not just gap-filled) because the
/// coverage profile used to measure this file (see the runbook in the task) compiles only
/// `HouseChannel*.t.sol`, which does not glob-match `SettleWithSeeds.t.sol`; duplicating their
/// core paths here keeps the coverage measurement accurate without touching those files.
///
/// mode-2 (settleWithProof) is exercised against a trivial LOCAL mock of IHonkVerifier — NOT the
/// generated UltraHonk verifier. HouseChannel only ever calls the verifier through that interface,
/// so a mock lets every Solidity-level branch of settleWithProof (BadStatus/BadParams/NoVerifier/
/// PayoutExceedsPot/BadProof/success+event+payout) be exercised in the DEFAULT profile with no
/// zkverify/zkm2 two-step build. What a mock cannot prove — that a REAL UltraHonk proof is honestly
/// accepted/rejected — stays the job of SettleWithProof.t.sol under the zkm2 profile; see the report.
contract MockHonkVerifier {
    bool public ok = true;

    function setOk(bool v) external {
        ok = v;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return ok;
    }
}

contract HouseChannelUnitTest is Test {
    Chips internal chips;
    HouseChannel internal ch;
    MockHonkVerifier internal mockVerifier;

    uint256 internal pkPlayerKey = 0xA11CE;
    uint256 internal pkHouse = 0xB0B;
    uint256 internal pkStranger = 0xBAD1;

    address internal playerWallet = address(uint160(uint256(keccak256("hcu-player-wallet"))));
    address internal playerKey;
    address internal house;
    address internal stranger;

    bytes32 internal constant TID = keccak256("hcu-main");
    bytes32 internal constant TID_ZERO = bytes32(0);
    uint64 internal constant CLOCK = 30;

    event Settled(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);
    event SettledWithProof(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);

    function setUp() public {
        chips = new Chips();
        ch = new HouseChannel(address(chips));
        mockVerifier = new MockHonkVerifier();
        playerKey = vm.addr(pkPlayerKey);
        house = vm.addr(pkHouse);
        stranger = vm.addr(pkStranger);
        ch.setHouseKey(house);

        chips.mint(playerWallet, 10_000);
        chips.mint(address(this), 100_000);
        chips.approve(address(ch), type(uint256).max);
        ch.fundHouse(5_000);
        vm.prank(playerWallet);
        chips.approve(address(ch), type(uint256).max);
    }

    // ============================== shared helpers ==============================

    function _baseTerms(bytes32 tableId) internal view returns (OpenTerms memory t) {
        t.tableId = tableId;
        t.player = playerWallet;
        t.playerKey = playerKey;
        t.escrowPlayer = 200;
        t.escrowHouse = 200;
        t.gameId = 1;
        t.rngCommit = keccak256("hcu-commit");
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
        t.clientSeedCommit = keccak256("hcu-client-commit");
        t.paramsHash = keccak256(abi.encode(uint256(5000)));
    }

    function _signHouseTerms(OpenTerms memory t) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, ch.openTermsDigest(t));
        return abi.encodePacked(r, s, v);
    }

    /// Open a table with the given terms via the player, signed by the house.
    function _open(OpenTerms memory t) internal {
        bytes memory sig = _signHouseTerms(t); // hoist: vm.prank affects only the very next call
        vm.prank(playerWallet);
        ch.open(t, sig);
    }

    function _state(bytes32 tableId, uint64 nonce, uint256 bp, uint256 bh, uint8 mode, uint8 gameId)
        internal
        pure
        returns (SessionState memory s)
    {
        s.tableId = tableId;
        s.nonce = nonce;
        s.balancePlayer = bp;
        s.balanceHouse = bh;
        s.settlementMode = mode;
        s.gameId = gameId;
        s.gameStateHash = bytes32(0);
        s.rngCommit = bytes32(0);
    }

    function _signState(SessionState memory s, uint256 pkPlayer, uint256 pkHouseSigner)
        internal
        view
        returns (bytes memory sp, bytes memory sh)
    {
        bytes32 d = ch.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 ss1) = vm.sign(pkPlayer, d);
        (uint8 v2, bytes32 r2, bytes32 ss2) = vm.sign(pkHouseSigner, d);
        sp = abi.encodePacked(r1, ss1, v1);
        sh = abi.encodePacked(r2, ss2, v2);
    }

    function _close(bytes32 tableId, uint64 nonce, uint256 bp, uint256 bh, uint8 gameId)
        internal
        pure
        returns (SessionClose memory c)
    {
        c.tableId = tableId;
        c.nonce = nonce;
        c.balancePlayer = bp;
        c.balanceHouse = bh;
        c.gameId = gameId;
    }

    function _signClose(SessionClose memory c, uint256 pkPlayer, uint256 pkHouseSigner)
        internal
        view
        returns (bytes memory sp, bytes memory sh)
    {
        bytes32 d = ch.closeDigest(c);
        (uint8 v1, bytes32 r1, bytes32 ss1) = vm.sign(pkPlayer, d);
        (uint8 v2, bytes32 r2, bytes32 ss2) = vm.sign(pkHouseSigner, d);
        sp = abi.encodePacked(r1, ss1, v1);
        sh = abi.encodePacked(r2, ss2, v2);
    }

    // ================================ admin: withdrawHouse ================================

    function test_withdrawHouseHappyPath() public {
        uint256 ownerBefore = chips.balanceOf(address(this));
        ch.withdrawHouse(1_000);
        assertEq(ch.housePool(), 4_000);
        assertEq(chips.balanceOf(address(this)), ownerBefore + 1_000);
    }

    function test_withdrawHouseInsufficientPoolReverts() public {
        vm.expectRevert(HousePoolBase.InsufficientPool.selector);
        ch.withdrawHouse(5_001);
    }

    // ==================================== open() reverts ====================================

    function test_openRejectsSenderMismatch() public {
        OpenTerms memory t = _baseTerms(TID);
        bytes memory sig = _signHouseTerms(t);
        vm.prank(address(0xDEAD)); // not terms.player
        vm.expectRevert(HouseChannel.NotPlayer.selector);
        ch.open(t, sig);
    }

    function test_openRejectsExpired() public {
        OpenTerms memory t = _baseTerms(TID);
        t.expiry = uint64(block.timestamp); // will warp past this
        bytes memory sig = _signHouseTerms(t);
        vm.warp(block.timestamp + 1);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.Expired.selector);
        ch.open(t, sig);
    }

    function test_openRejectsClockTooLow() public {
        OpenTerms memory t = _baseTerms(TID);
        t.clockBlocks = ch.MIN_CLOCK_BLOCKS() - 1;
        bytes memory sig = _signHouseTerms(t);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadClock.selector);
        ch.open(t, sig);
    }

    function test_openRejectsClockTooHigh() public {
        OpenTerms memory t = _baseTerms(TID);
        t.clockBlocks = ch.MAX_CLOCK_BLOCKS() + 1;
        bytes memory sig = _signHouseTerms(t);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadClock.selector);
        ch.open(t, sig);
    }

    function test_openRejectsZeroPlayerKey() public {
        OpenTerms memory t = _baseTerms(TID);
        t.playerKey = address(0);
        bytes memory sig = _signHouseTerms(t);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.NotPlayer.selector);
        ch.open(t, sig);
    }

    function test_openRejectsPlayerKeyEqualsHouseKey() public {
        OpenTerms memory t = _baseTerms(TID);
        t.playerKey = house; // colludes with the house signing key
        bytes memory sig = _signHouseTerms(t);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.NotPlayer.selector);
        ch.open(t, sig);
    }

    function test_openRejectsAlreadyLiveTable() public {
        OpenTerms memory t = _baseTerms(TID);
        _open(t); // first open succeeds, table now Live
        bytes memory sig2 = _signHouseTerms(t); // freshly signed, otherwise identical
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.open(t, sig2);
    }

    function test_openRejectsInsufficientHousePool() public {
        OpenTerms memory t = _baseTerms(TID);
        t.escrowHouse = ch.housePool() + 1; // exceeds the funded pool, validly signed
        bytes memory sig = _signHouseTerms(t);
        vm.prank(playerWallet);
        vm.expectRevert(HousePoolBase.InsufficientPool.selector);
        ch.open(t, sig);
    }

    // ============================ WrongTable (both call sites) ============================
    // s.tableId==0 (a table WAS opened at id 0, else the caller's own status precondition would
    // fire BadStatus first) is the only reachable disjunct of `_checkCoSigned`/`_checkCloseCoSigned`'s
    // WrongTable check — see the report for why the `t.status==None` disjunct is dead code.

    function test_disputeRejectsZeroTableId() public {
        _open(_baseTerms(TID_ZERO));
        SessionState memory s = _state(TID_ZERO, 1, 200, 200, 1, 1);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.WrongTable.selector);
        ch.dispute(s, "", ""); // reverts before signatures are ever checked
    }

    function test_settleRejectsZeroTableId() public {
        _open(_baseTerms(TID_ZERO));
        SessionClose memory c = _close(TID_ZERO, 1, 200, 200, 1);
        vm.expectRevert(HouseChannel.WrongTable.selector);
        ch.settle(c, "", "");
    }

    // ============ own BadStatus guard on each state-machine entrypoint (never-opened table) ============
    // Every dispute-path function gates on the table's OWN status before doing anything else; none of
    // the existing suites call these on a table in the wrong status, so each of these 5 sites was
    // previously unexercised even though the shared BadStatus error is well-tested elsewhere.

    function test_disputeRejectsBadStatus() public {
        SessionState memory s = _state(keccak256("hcu-never-opened-1"), 1, 0, 0, 1, 1);
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.dispute(s, "", "");
    }

    function test_disputeFromOpenRejectsBadStatus() public {
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.disputeFromOpen(keccak256("hcu-never-opened-2"));
    }

    function test_claimForfeitRejectsBadStatus() public {
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.claimForfeit(keccak256("hcu-never-opened-3"));
    }

    function test_respondWithStateRejectsBadStatus() public {
        // table IS open (Live) but never disputed -> not Disputed
        _open(_baseTerms(TID));
        SessionState memory s = _state(TID, 1, 200, 200, 1, 1);
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.respondWithState(s, "", "");
    }

    function test_resolveTimeoutRejectsBadStatus() public {
        // table IS open (Live) but never disputed -> not Disputed
        _open(_baseTerms(TID));
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.resolveTimeout(TID);
    }

    // ======================= _checkCoSigned: BadMode / ConservationViolated =======================
    // (distinct source lines from settle()'s _checkCloseCoSigned, which already has coverage)

    function test_disputeRejectsBadMode() public {
        _open(_baseTerms(TID));
        SessionState memory s = _state(TID, 1, 200, 200, 0, 1); // settlementMode 0, not 1
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadMode.selector);
        ch.dispute(s, "", ""); // BadMode fires before signatures are checked
    }

    function test_disputeRejectsConservationViolated() public {
        _open(_baseTerms(TID));
        SessionState memory s = _state(TID, 1, 201, 200, 1, 1); // 401 != 400
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.ConservationViolated.selector);
        ch.dispute(s, "", "");
    }

    // ======================= _checkCoSigned / _checkCloseCoSigned: BadSig sub-branches =======================

    function test_disputeRejectsBadSigPlayer() public {
        _open(_baseTerms(TID));
        SessionState memory s = _state(TID, 1, 200, 200, 1, 1);
        (, bytes memory sh) = _signState(s, pkPlayerKey, pkHouse);
        (bytes memory badSp,) = _signState(s, pkStranger, pkHouse); // wrong player signer
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadSig.selector);
        ch.dispute(s, badSp, sh);
    }

    function test_disputeRejectsBadSigHouse() public {
        _open(_baseTerms(TID));
        SessionState memory s = _state(TID, 1, 200, 200, 1, 1);
        (bytes memory sp,) = _signState(s, pkPlayerKey, pkHouse);
        (, bytes memory badSh) = _signState(s, pkPlayerKey, pkStranger); // wrong house signer
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadSig.selector);
        ch.dispute(s, sp, badSh);
    }

    function test_settleRejectsBadSigHouse() public {
        _open(_baseTerms(TID));
        SessionClose memory c = _close(TID, 1, 200, 200, 1);
        (bytes memory sp,) = _signClose(c, pkPlayerKey, pkHouse);
        (, bytes memory badSh) = _signClose(c, pkPlayerKey, pkStranger); // wrong house signer
        vm.expectRevert(HouseChannel.BadSig.selector);
        ch.settle(c, sp, badSh);
    }

    // ==================================== settleWithSeeds (mode 1) ====================================
    // Re-exercised here: SettleWithSeeds.t.sol does not glob-match `HouseChannel*.t.sol`, so it is
    // excluded from the trimmed coverage-profile compile. Vectors match the existing suite exactly
    // (dice @ nonce 1, pinned against the real gibs/msgboard-games math via gen-recompute-vectors).

    bytes32 internal constant SEEDS_SERVER_WIN = bytes32(uint256(1));
    bytes32 internal constant SEEDS_CLIENT_WIN = bytes32(uint256(2));
    bytes32 internal constant SEEDS_SERVER_LOSS = bytes32(uint256(3));
    bytes32 internal constant SEEDS_CLIENT_LOSS = bytes32(uint256(4));
    uint256 internal constant SEEDS_TARGET = 5000;
    uint256 internal constant SEEDS_ESCROW_PLAYER = 200;
    uint256 internal constant SEEDS_ESCROW_HOUSE = 196;
    uint256 internal constant SEEDS_PAYOUT_WIN = 396;

    function _seedsParams() internal pure returns (bytes memory) {
        return abi.encode(SEEDS_TARGET);
    }

    function _openSeeds(bytes32 tableId, bytes32 serverSeed, bytes32 clientSeed) internal {
        OpenTerms memory t = _baseTerms(tableId);
        t.escrowPlayer = SEEDS_ESCROW_PLAYER;
        t.escrowHouse = SEEDS_ESCROW_HOUSE;
        t.rngCommit = keccak256(abi.encodePacked(serverSeed));
        t.clientSeedCommit = keccak256(abi.encodePacked(clientSeed));
        t.paramsHash = keccak256(_seedsParams());
        _open(t);
    }

    function test_settleWithSeedsHonestWinPaysPlayer() public {
        bytes32 tid = keccak256("hcu-seeds-win");
        _openSeeds(tid, SEEDS_SERVER_WIN, SEEDS_CLIENT_WIN);
        uint256 playerBefore = chips.balanceOf(playerWallet);
        uint256 poolBefore = ch.housePool();
        ch.settleWithSeeds(tid, SEEDS_SERVER_WIN, SEEDS_CLIENT_WIN, _seedsParams());
        assertEq(chips.balanceOf(playerWallet), playerBefore + SEEDS_PAYOUT_WIN);
        uint256 toHouse = (SEEDS_ESCROW_PLAYER + SEEDS_ESCROW_HOUSE) - SEEDS_PAYOUT_WIN;
        assertEq(ch.housePool(), poolBefore + toHouse);
    }

    function test_settleWithSeedsHonestLossPaysHouse() public {
        bytes32 tid = keccak256("hcu-seeds-loss");
        _openSeeds(tid, SEEDS_SERVER_LOSS, SEEDS_CLIENT_LOSS);
        uint256 playerBefore = chips.balanceOf(playerWallet);
        uint256 poolBefore = ch.housePool();
        ch.settleWithSeeds(tid, SEEDS_SERVER_LOSS, SEEDS_CLIENT_LOSS, _seedsParams());
        assertEq(chips.balanceOf(playerWallet), playerBefore); // no payout
        assertEq(ch.housePool(), poolBefore + SEEDS_ESCROW_PLAYER + SEEDS_ESCROW_HOUSE);
    }

    function test_settleWithSeedsBadStatusReverts() public {
        bytes32 tid = keccak256("hcu-seeds-double");
        _openSeeds(tid, SEEDS_SERVER_LOSS, SEEDS_CLIENT_LOSS);
        ch.settleWithSeeds(tid, SEEDS_SERVER_LOSS, SEEDS_CLIENT_LOSS, _seedsParams());
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.settleWithSeeds(tid, SEEDS_SERVER_LOSS, SEEDS_CLIENT_LOSS, _seedsParams());
    }

    function test_settleWithSeedsBadServerSeedReverts() public {
        bytes32 tid = keccak256("hcu-seeds-badserver");
        _openSeeds(tid, SEEDS_SERVER_WIN, SEEDS_CLIENT_WIN);
        vm.expectRevert(HouseChannel.BadReveal.selector);
        ch.settleWithSeeds(tid, bytes32(uint256(99)), SEEDS_CLIENT_WIN, _seedsParams());
    }

    function test_settleWithSeedsBadClientSeedReverts() public {
        bytes32 tid = keccak256("hcu-seeds-badclient");
        _openSeeds(tid, SEEDS_SERVER_WIN, SEEDS_CLIENT_WIN);
        vm.expectRevert(HouseChannel.BadReveal.selector);
        ch.settleWithSeeds(tid, SEEDS_SERVER_WIN, bytes32(uint256(99)), _seedsParams());
    }

    function test_settleWithSeedsBadParamsReverts() public {
        bytes32 tid = keccak256("hcu-seeds-badparams");
        _openSeeds(tid, SEEDS_SERVER_WIN, SEEDS_CLIENT_WIN);
        vm.expectRevert(HouseChannel.BadParams.selector);
        ch.settleWithSeeds(tid, SEEDS_SERVER_WIN, SEEDS_CLIENT_WIN, abi.encode(uint256(1234)));
    }

    // ================================ settleWithProof (mode 2, mocked) ================================
    // Exercises every Solidity-level branch of settleWithProof against a trivial local mock of
    // IHonkVerifier — see the MockHonkVerifier / contract doc comment at the top of this file for why
    // this is in-scope for the default profile (no zkverify/zkm2 build involved).

    uint256 internal constant PROOF_ESCROW_PLAYER = 1_000;
    uint256 internal constant PROOF_ESCROW_HOUSE = 500;
    uint256 internal constant PROOF_POT = PROOF_ESCROW_PLAYER + PROOF_ESCROW_HOUSE;

    function _proofParams() internal pure returns (bytes memory) {
        return abi.encode(uint256(5000));
    }

    function _openForProof(bytes32 tableId) internal {
        OpenTerms memory t = _baseTerms(tableId);
        t.escrowPlayer = PROOF_ESCROW_PLAYER;
        t.escrowHouse = PROOF_ESCROW_HOUSE;
        t.paramsHash = keccak256(_proofParams());
        _open(t);
    }

    function test_settleWithProofBadStatusReverts() public {
        // never opened -> status None, not Live
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.settleWithProof(keccak256("hcu-proof-neveropened"), _proofParams(), 0, "");
    }

    function test_settleWithProofBadParamsReverts() public {
        bytes32 tid = keccak256("hcu-proof-badparams");
        _openForProof(tid);
        vm.expectRevert(HouseChannel.BadParams.selector);
        ch.settleWithProof(tid, abi.encode(uint256(1234)), 100, "");
    }

    function test_settleWithProofNoVerifierReverts() public {
        bytes32 tid = keccak256("hcu-proof-noverifier");
        _openForProof(tid); // proofVerifier[1] left unset (address(0))
        vm.expectRevert(HouseChannel.NoVerifier.selector);
        ch.settleWithProof(tid, _proofParams(), 100, "");
    }

    function test_settleWithProofPayoutExceedsPotReverts() public {
        bytes32 tid = keccak256("hcu-proof-exceedspot");
        _openForProof(tid);
        ch.setProofVerifier(1, address(mockVerifier));
        vm.expectRevert(HouseChannel.PayoutExceedsPot.selector);
        ch.settleWithProof(tid, _proofParams(), PROOF_POT + 1, "");
    }

    function test_settleWithProofBadProofReverts() public {
        bytes32 tid = keccak256("hcu-proof-badproof");
        _openForProof(tid);
        ch.setProofVerifier(1, address(mockVerifier));
        mockVerifier.setOk(false); // verifier honestly rejects
        vm.expectRevert(HouseChannel.BadProof.selector);
        ch.settleWithProof(tid, _proofParams(), 800, "");
    }

    function test_settleWithProofMockVerifierSettlesAndConserves() public {
        bytes32 tid = keccak256("hcu-proof-settles");
        _openForProof(tid);
        ch.setProofVerifier(1, address(mockVerifier)); // ok defaults true
        uint256 playerBefore = chips.balanceOf(playerWallet);
        uint256 poolBefore = ch.housePool();
        uint256 payoutPlayer = 800;

        vm.expectEmit(true, false, false, true, address(ch));
        emit SettledWithProof(tid, payoutPlayer, PROOF_POT - payoutPlayer);
        ch.settleWithProof(tid, _proofParams(), payoutPlayer, "");

        assertEq(chips.balanceOf(playerWallet), playerBefore + payoutPlayer);
        assertEq(ch.housePool(), poolBefore + (PROOF_POT - payoutPlayer));
    }

    function test_settleWithProofDoubleSettleReverts() public {
        bytes32 tid = keccak256("hcu-proof-double");
        _openForProof(tid);
        ch.setProofVerifier(1, address(mockVerifier));
        ch.settleWithProof(tid, _proofParams(), 800, "");
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.settleWithProof(tid, _proofParams(), 800, "");
    }
}
