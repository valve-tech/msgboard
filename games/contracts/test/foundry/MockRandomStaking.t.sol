// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {MockRandomStaking} from "./MockRandomStaking.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";

contract MockRandomStakingTest is Test {
    MockRandomStaking rnd; ERC20 tok; address game = address(0x6A);
    function setUp() public { rnd = new MockRandomStaking(); tok = new ERC20(false); }

    function _info(uint256 price) internal pure returns (PreimageLocation.Info[] memory a) {
        a = new PreimageLocation.Info[](3);
        for (uint256 i; i < 3; ++i) a[i] = PreimageLocation.Info({
            provider: address(uint160(0x3000+i)), callAtChange: true, durationIsTimestamp: false,
            duration: 12, token: address(0), price: price, offset: 0, index: 0 });
    }

    function test_chop_forfeits_withholder_price_to_owner() public {
        // fund the game's custody so heat's fee can be charged
        tok.mint(game, 100 ether); vm.prank(game); tok.approve(address(rnd), type(uint256).max);
        vm.prank(game); rnd.deposit(address(tok), 100 ether);
        PreimageLocation.Info[] memory info = _info(10 ether);
        for (uint256 i; i < 3; ++i) info[i].token = address(tok);
        PreimageLocation.Info memory settings = info[0];
        vm.prank(game);
        bytes32 key = rnd.heat(3, settings, info, false);
        // fee = 3*10 = 30 charged
        assertEq(rnd.balanceOf(game, address(tok)), 70 ether);
        // 2 of 3 revealed → 1 withheld → forfeit 10; plus fee refund 30
        rnd.setRevealed(key, 0x3); // bits 0,1 revealed
        rnd.chop(key, info);
        assertEq(rnd.balanceOf(game, address(tok)), 70 ether + 30 ether + 10 ether);
    }
}
