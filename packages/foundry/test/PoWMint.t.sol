// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";
import {PoWMint} from "../examples/PoWMint.sol";

/// Exercises the PoWMint example end-to-end using the revised golden vector (deterministic, CI-safe).
/// PoWMint verifies with the canonical `MsgPow.verify`, so the example runs on the revised stamp.
contract PoWMintTest is Test {
    uint256 internal constant MINT_AMOUNT = 1_000 ether;

    function _load() internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        string memory json = vm.readFile("./test/vectors/v2.json");
        m.version = uint8(vm.parseUint(vm.parseJsonString(json, ".stamp.version")));
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".stamp.nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".stamp.blockHash");
        m.category = vm.parseJsonBytes32(json, ".stamp.category");
        m.data = vm.parseJsonBytes(json, ".stamp.data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".stamp.workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".stamp.workDivisor")));
        difficulty = vm.parseUint(vm.parseJsonString(json, ".stamp.difficulty"));
    }

    function test_mint_with_valid_work() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWMint token = new PoWMint(difficulty, MINT_AMOUNT);

        uint256 minted = token.mintWithWork(m);

        assertEq(minted, MINT_AMOUNT, "returns the minted amount");
        assertEq(token.balanceOf(address(this)), MINT_AMOUNT, "credits the caller");
        assertEq(token.totalSupply(), MINT_AMOUNT, "increases total supply");
        (, bytes32 wh) = MsgPow.workHash(m);
        assertTrue(token.claimed(wh), "marks the stamp claimed");
    }

    function test_mint_rejects_replay() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWMint token = new PoWMint(difficulty, MINT_AMOUNT);
        token.mintWithWork(m);
        vm.expectRevert("PoWMint: work already claimed");
        token.mintWithWork(m);
    }

    /// A stamp is global: a different caller cannot reuse it to mint again.
    function test_mint_stamp_cannot_be_reused_by_another_caller() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWMint token = new PoWMint(difficulty, MINT_AMOUNT);
        token.mintWithWork(m);

        vm.prank(address(0xBEEF));
        vm.expectRevert("PoWMint: work already claimed");
        token.mintWithWork(m);
    }

    function test_mint_rejects_invalid_work() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWMint token = new PoWMint(difficulty, MINT_AMOUNT);
        m.nonce += 1; // tamper invalidates the proof of work
        vm.expectRevert("PoWMint: invalid work");
        token.mintWithWork(m);
    }
}
