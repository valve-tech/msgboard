// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20 as SolERC20} from "solady/src/tokens/ERC20.sol";

contract ERC20 is SolERC20 {
    bool internal immutable _shouldBurn;
    uint256 internal constant ONE_ETHER = 1 ether;
    uint256 internal constant TAX_NUMERATOR = ONE_ETHER - (ONE_ETHER / 100);

    constructor(bool shouldBurn) payable {
        _shouldBurn = shouldBurn;
    }

    function name() public pure override returns (string memory) {
        return "";
    }

    function symbol() public pure override returns (string memory) {
        return "";
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function _afterTokenTransfer(address from, address to, uint256 amount) internal override {
        if (_shouldBurn && from != address(0) && to != address(0)) {
            _burn(to, amount - ((amount * TAX_NUMERATOR) / ONE_ETHER));
        }
    }

    function taxRatio() external pure returns (uint256) {
        return TAX_NUMERATOR;
    }
}
