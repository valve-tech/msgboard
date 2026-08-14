// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {IFeePolicy} from "../../contracts/games/operator/IFeePolicy.sol";
import {BurnFeePolicy} from "../../contracts/games/operator/BurnFeePolicy.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

/// @notice Unit suite for the default neutral sink. BurnFeePolicy must burn everything routed to it
/// (send it to the dead address), count the burn per token for QA, and quote a zero fee for every kind —
/// the forfeit call site routes the full amount and never reads feeBps.
contract FeePolicyTest is Test {
    using SafeTransferLib for address;

    bytes32 internal constant FORFEIT_KIND = keccak256("forfeit");
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    BurnFeePolicy internal policy;
    ERC20 internal tok;

    function setUp() public {
        policy = new BurnFeePolicy();
        tok = new ERC20(false);
    }

    function test_route_burnsFullAmount_countsBurned() public {
        uint256 amount = 5 ether;
        // The fee producer delivers the tokens to the policy, then calls route.
        tok.mint(address(policy), amount);
        assertEq(tok.balanceOf(address(policy)), amount);

        policy.route(FORFEIT_KIND, address(tok), amount, "");

        // Tokens left the policy to the dead address, and the burn is counted per token.
        assertEq(tok.balanceOf(address(policy)), 0);
        assertEq(tok.balanceOf(DEAD), amount);
        assertEq(policy.burned(address(tok)), amount);
    }

    function test_feeBps_isZero_forForfeit() public view {
        assertEq(policy.feeBps(FORFEIT_KIND, address(tok), address(this)), 0);
    }
}
