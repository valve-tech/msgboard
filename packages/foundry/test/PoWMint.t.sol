// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";
import {PoWMint} from "../examples/PoWMint.sol";

/// Exercises the PoWMint example end-to-end using the golden vector (deterministic, CI-safe).
contract PoWMintTest is Test {
    uint256 internal constant MINT_AMOUNT = 1_000 ether;

    function _load() internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        string memory json = vm.readFile("./test/vectors/valid.json");
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".blockHash");
        m.category = vm.parseJsonBytes32(json, ".category");
        m.data = vm.parseJsonBytes(json, ".data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".workDivisor")));
        difficulty = vm.parseUint(vm.parseJsonString(json, ".difficulty"));
    }

    function test_mint_with_valid_work() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWMint token = new PoWMint(difficulty, MINT_AMOUNT);

        uint256 minted = token.mintWithWork(m);

        assertEq(minted, MINT_AMOUNT, "returns the minted amount");
        assertEq(token.balanceOf(address(this)), MINT_AMOUNT, "credits the caller");
        assertEq(token.totalSupply(), MINT_AMOUNT, "increases total supply");
        assertTrue(token.claimed(MsgPow.workHash(m)), "marks the stamp claimed");
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
