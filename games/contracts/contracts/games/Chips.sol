// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "solady/src/tokens/ERC20.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";

/// The mintable per-chain accounting unit (spec: chips are a mintable ERC20; the house can
/// mint to pay, so house solvency is never what picks the settlement mode). Owner = the house
/// deployer; only the owner mints. Plain ERC20 otherwise.
contract Chips is ERC20, Ownable {
    constructor() {
        _initializeOwner(msg.sender);
    }

    function name() public pure override returns (string memory) {
        return "MsgBoard Chips";
    }

    function symbol() public pure override returns (string memory) {
        return "CHIP";
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
