// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseChannel, OpenTerms} from "../../contracts/games/HouseChannel.sol";

// Foundry tests for the permissionless on-chain recompute settle (settleWithSeeds). The
// dice-win / dice-loss seed triples are the SAME ones the Task 2 vector script
// (gen-recompute-vectors.ts) used against the REAL gibs/msgboard-games dice math at NONCE 1:
//   dice-win : serverSeed=bytes32(1) clientSeed=bytes32(2) -> win  @ nonce 1 (payout 396)
//   dice-loss: serverSeed=bytes32(3) clientSeed=bytes32(4) -> loss @ nonce 1 (payout 0)
// So the on-chain recompute (nonce hardcoded to 1) is anchored to a KNOWN outcome.
contract SettleWithSeedsTest is Test {
    Chips internal chips;
    HouseChannel internal ch;

    uint256 internal pkHouse = 0xB0B;
    address internal playerWallet = address(uint160(uint256(keccak256("player-wallet"))));
    address internal playerKey = address(uint160(uint256(keccak256("player-key"))));
    address internal house;

    bytes32 internal constant TID = keccak256("sws1");
    uint64 internal constant CLOCK = 30;

    // dice-win / dice-loss triples (== gen-recompute-vectors seeds s(1)/s(2) and s(3)/s(4))
    bytes32 internal constant SERVER_WIN = bytes32(uint256(1));
    bytes32 internal constant CLIENT_WIN = bytes32(uint256(2));
    bytes32 internal constant SERVER_LOSS = bytes32(uint256(3));
    bytes32 internal constant CLIENT_LOSS = bytes32(uint256(4));
    uint256 internal constant TARGET = 5000;

    // Sized from GamePayouts.t.sol: dice@5000 mult = 198 => win profit = 200*(198-100)/100 = 196,
    // so escrowHouse = 196 makes the pot 396 == the win payout (escrow ceiling exactly met).
    uint256 internal constant ESCROW_PLAYER = 200;
    uint256 internal constant ESCROW_HOUSE = 196;
    uint256 internal constant PAYOUT_WIN = 396; // dice-win payout from gen-recompute-vectors

    function setUp() public {
        chips = new Chips();
        ch = new HouseChannel(address(chips));
        house = vm.addr(pkHouse);
        ch.setHouseKey(house);
        chips.mint(playerWallet, 1_000);
        chips.mint(address(this), 10_000);
        chips.approve(address(ch), type(uint256).max);
        ch.fundHouse(10_000);
        vm.prank(playerWallet);
        chips.approve(address(ch), type(uint256).max);
    }

    function _params() internal pure returns (bytes memory) {
        return abi.encode(TARGET);
    }

    function _terms(bytes32 serverSeed, bytes32 clientSeed) internal view returns (OpenTerms memory t) {
        t.tableId = TID;
        t.player = playerWallet;
        t.playerKey = playerKey;
        t.escrowPlayer = ESCROW_PLAYER;
        t.escrowHouse = ESCROW_HOUSE;
        t.gameId = 1;
        t.rngCommit = keccak256(abi.encodePacked(serverSeed));
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
        t.clientSeedCommit = keccak256(abi.encodePacked(clientSeed));
        t.paramsHash = keccak256(_params());
    }

    function _open(bytes32 serverSeed, bytes32 clientSeed) internal returns (OpenTerms memory t) {
        t = _terms(serverSeed, clientSeed);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, ch.openTermsDigest(t));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(playerWallet);
        ch.open(t, sig);
    }

    function test_honestWinPaysPlayer() public {
        _open(SERVER_WIN, CLIENT_WIN);
        uint256 playerBefore = chips.balanceOf(playerWallet);
        uint256 poolBefore = ch.housePool();
        ch.settleWithSeeds(TID, SERVER_WIN, CLIENT_WIN, _params());
        // payout == dice-win payout from gen-recompute-vectors; player balance rises by exactly it.
        assertEq(chips.balanceOf(playerWallet), playerBefore + PAYOUT_WIN);
        // pot fully distributed: player gets PAYOUT_WIN (== whole pot here), house share returns to pool.
        uint256 toHouse = (ESCROW_PLAYER + ESCROW_HOUSE) - PAYOUT_WIN;
        assertEq(ch.housePool(), poolBefore + toHouse);
        // conservation: payoutPlayer + payoutHouse == escrowPlayer + escrowHouse
        assertEq(PAYOUT_WIN + toHouse, ESCROW_PLAYER + ESCROW_HOUSE);
    }

    function test_honestLossPaysHouse() public {
        _open(SERVER_LOSS, CLIENT_LOSS);
        uint256 poolBefore = ch.housePool();
        uint256 playerBefore = chips.balanceOf(playerWallet);
        ch.settleWithSeeds(TID, SERVER_LOSS, CLIENT_LOSS, _params());
        assertEq(chips.balanceOf(playerWallet), playerBefore); // no payout
        assertEq(ch.housePool(), poolBefore + ESCROW_PLAYER + ESCROW_HOUSE); // whole pot returns to pool
    }

    function test_badServerSeedReverts() public {
        _open(SERVER_WIN, CLIENT_WIN);
        vm.expectRevert(HouseChannel.BadReveal.selector);
        ch.settleWithSeeds(TID, bytes32(uint256(99)), CLIENT_WIN, _params());
    }

    function test_badClientSeedReverts() public {
        _open(SERVER_WIN, CLIENT_WIN);
        vm.expectRevert(HouseChannel.BadReveal.selector);
        ch.settleWithSeeds(TID, SERVER_WIN, bytes32(uint256(99)), _params());
    }

    function test_badParamsReverts() public {
        _open(SERVER_WIN, CLIENT_WIN);
        vm.expectRevert(HouseChannel.BadParams.selector);
        ch.settleWithSeeds(TID, SERVER_WIN, CLIENT_WIN, abi.encode(uint256(1234)));
    }

    // SECURITY: nonce is NOT a caller input — it is hardcoded to 1 inside settleWithSeeds. The chosen
    // SERVER_WIN/CLIENT_WIN triple is the gen-recompute-vectors "dice-win" triple AT NONCE 1, so the
    // honest reveal pays the player; there is no way for a settler to pass a different nonce to grind a
    // different outcome (the param simply does not exist). This test pins that the win is realized from
    // ONLY the seeds + params — no nonce argument is available to manipulate.
    function test_outcomeFixedByNonceOne() public {
        _open(SERVER_WIN, CLIENT_WIN);
        uint256 before = chips.balanceOf(playerWallet);
        ch.settleWithSeeds(TID, SERVER_WIN, CLIENT_WIN, _params()); // dice-win @ nonce 1
        assertEq(chips.balanceOf(playerWallet), before + PAYOUT_WIN); // win realized, deterministically
    }

    function test_doubleSettleReverts() public {
        _open(SERVER_LOSS, CLIENT_LOSS);
        ch.settleWithSeeds(TID, SERVER_LOSS, CLIENT_LOSS, _params());
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.settleWithSeeds(TID, SERVER_LOSS, CLIENT_LOSS, _params());
    }
}
