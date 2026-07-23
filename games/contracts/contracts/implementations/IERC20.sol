// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

abstract contract IERC20 {
    function transfer(address to, uint256 amount) external virtual returns (bool);
}
