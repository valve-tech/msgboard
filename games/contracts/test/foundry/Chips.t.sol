// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";

contract ChipsTest is Test {
    Chips internal chips;
    address internal owner = address(this);
    address internal alice = address(0xA11CE);

    function setUp() public {
        chips = new Chips();
    }

    function test_ownerMints() public {
        chips.mint(alice, 1_000);
        assertEq(chips.balanceOf(alice), 1_000);
        assertEq(chips.totalSupply(), 1_000);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(); // Solady Ownable: Unauthorized()
        chips.mint(alice, 1);
    }

    function test_transferMovesBalance() public {
        chips.mint(owner, 100);
        chips.transfer(alice, 40);
        assertEq(chips.balanceOf(alice), 40);
        assertEq(chips.balanceOf(owner), 60);
    }
}
